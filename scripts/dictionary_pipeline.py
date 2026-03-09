from __future__ import annotations

import csv
import math
import re
from collections.abc import Iterable, Iterator, Sequence
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import spacy
from spacy.lang.en.stop_words import STOP_WORDS
from wordfreq import top_n_list, zipf_frequency

WORD_RE = re.compile(r"^[a-z]+$")
DEFAULT_VECTOR_DIM = 300
DEFAULT_SURFACE_POOL_SIZE = 300_000
DEFAULT_VECTOR_PROBE_FACTOR = 4
TARGET_BLOCKLIST_FILENAME = "target_blocklist.txt"
LEXICAL_POS = ("NOUN", "VERB", "ADJ", "ADV")
DEFAULT_SPACY_MODELS = ("en_core_web_md", "en_core_web_sm")
TARGET_HELPER_VERBS = {"be", "do", "have"}
POS_PREFERENCE = {"NOUN": 0, "VERB": 1, "ADJ": 2, "ADV": 3}

IRREGULAR_VERBS = {
    "am": "be",
    "are": "be",
    "been": "be",
    "began": "begin",
    "begun": "begin",
    "bent": "bend",
    "bit": "bite",
    "bought": "buy",
    "brought": "bring",
    "built": "build",
    "came": "come",
    "caught": "catch",
    "chose": "choose",
    "chosen": "choose",
    "did": "do",
    "does": "do",
    "done": "do",
    "drank": "drink",
    "driven": "drive",
    "drove": "drive",
    "eaten": "eat",
    "fell": "fall",
    "felt": "feel",
    "flew": "fly",
    "flown": "fly",
    "forgot": "forget",
    "forgiven": "forgive",
    "forgave": "forgive",
    "fought": "fight",
    "found": "find",
    "gave": "give",
    "given": "give",
    "gone": "go",
    "got": "get",
    "grown": "grow",
    "grew": "grow",
    "had": "have",
    "has": "have",
    "heard": "hear",
    "held": "hold",
    "is": "be",
    "kept": "keep",
    "knew": "know",
    "known": "know",
    "laid": "lay",
    "led": "lead",
    "left": "leave",
    "lost": "lose",
    "made": "make",
    "meant": "mean",
    "met": "meet",
    "paid": "pay",
    "ran": "run",
    "read": "read",
    "rode": "ride",
    "ridden": "ride",
    "rose": "rise",
    "risen": "rise",
    "said": "say",
    "sang": "sing",
    "saw": "see",
    "seen": "see",
    "sent": "send",
    "shook": "shake",
    "shaken": "shake",
    "shot": "shoot",
    "slept": "sleep",
    "sold": "sell",
    "spent": "spend",
    "spoke": "speak",
    "spoken": "speak",
    "stood": "stand",
    "stole": "steal",
    "stolen": "steal",
    "swam": "swim",
    "swum": "swim",
    "taught": "teach",
    "thought": "think",
    "told": "tell",
    "took": "take",
    "taken": "take",
    "understood": "understand",
    "was": "be",
    "went": "go",
    "were": "be",
    "won": "win",
    "wore": "wear",
    "worn": "wear",
    "wrote": "write",
    "written": "write",
}

IRREGULAR_NOUNS = {
    "children": "child",
    "feet": "foot",
    "geese": "goose",
    "knives": "knife",
    "leaves": "leaf",
    "lives": "life",
    "men": "man",
    "mice": "mouse",
    "people": "person",
    "teeth": "tooth",
    "women": "woman",
}

IRREGULAR_ADJECTIVES = {
    "better": "good",
    "best": "good",
    "farther": "far",
    "farthest": "far",
    "further": "far",
    "furthest": "far",
    "lesser": "little",
    "least": "little",
    "worse": "bad",
    "worst": "bad",
}

IRREGULAR_ADVERBS = {
    "better": "well",
    "best": "well",
}

ADJECTIVE_SUFFIXES = (
    "able",
    "al",
    "ary",
    "ed",
    "ful",
    "ible",
    "ic",
    "ish",
    "ive",
    "less",
    "ous",
    "y",
)
NOUN_SUFFIXES = (
    "acy",
    "age",
    "ance",
    "ence",
    "dom",
    "er",
    "hood",
    "ism",
    "ist",
    "ity",
    "ment",
    "ness",
    "or",
    "ship",
    "sion",
    "tion",
)


@dataclass
class ResolvedToken:
    surface: str
    lemma: str | None
    pos: str | None
    source: str


@dataclass
class SurfaceRecord:
    surface: str
    lemma: str | None
    pos: str | None
    frequency: float
    in_vectors: bool = False
    kept_allowed: bool = False
    kept_target: bool = False
    exclusion_reason: str = ""


@dataclass
class LemmaEntry:
    lemma: str
    aggregate_frequency: float = 0.0
    best_surface_frequency: float = 0.0
    dominant_pos: str = "NOUN"
    pos_scores: dict[str, float] = field(default_factory=dict)
    surface_forms: set[str] = field(default_factory=set)


@dataclass
class BuildArtifacts:
    allowed_vocab: list[str]
    targets: list[str]
    word_index: dict[str, int]
    matrix: np.ndarray
    vectors_by_word: dict[str, np.ndarray]
    surface_records: list[SurfaceRecord]
    ranked_lemma_count: int
    resolver_mode: str
    surface_pool_size: int


def read_word_list(path: Path) -> list[str]:
    if not path.exists():
        raise FileNotFoundError(f"Missing file: {path}")

    words: list[str] = []
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip().lower()
        if not line or line.startswith("#"):
            continue
        words.append(line)
    return words


def write_text_list(path: Path, words: Iterable[str]) -> None:
    path.write_text("".join(f"{word}\n" for word in words), encoding="utf-8")


def load_target_blocklist(out_dir: Path) -> set[str]:
    blocklist_path = out_dir / TARGET_BLOCKLIST_FILENAME
    if not blocklist_path.exists():
        return set()
    return {word for word in read_word_list(blocklist_path) if WORD_RE.fullmatch(word)}


def load_stopwords(extra_stopwords_file: Path | None = None) -> set[str]:
    stopwords = {word.lower() for word in STOP_WORDS if WORD_RE.fullmatch(word.lower())}
    if extra_stopwords_file and extra_stopwords_file.exists():
        stopwords.update(
            word for word in read_word_list(extra_stopwords_file) if WORD_RE.fullmatch(word)
        )
    return stopwords


def aggregate_frequency(zipf: float) -> float:
    return math.pow(10.0, max(zipf, 0.0))


def _dedupe_candidates(candidates: Iterable[str]) -> list[str]:
    seen: set[str] = set()
    ordered: list[str] = []
    for candidate in candidates:
        if candidate in seen:
            continue
        seen.add(candidate)
        ordered.append(candidate)
    return ordered


def _strip_double_consonant(word: str) -> str:
    if len(word) >= 2 and word[-1] == word[-2] and word[-1] not in "aeiou":
        return word[:-1]
    return word


def _best_candidate(candidates: Iterable[str], fallback: str) -> str:
    valid = [candidate for candidate in _dedupe_candidates(candidates) if WORD_RE.fullmatch(candidate)]
    if not valid:
        return fallback
    valid.sort(key=lambda candidate: (-zipf_frequency(candidate, "en"), len(candidate), candidate))
    return valid[0]


def _noun_lemma(word: str) -> str:
    if word in IRREGULAR_NOUNS:
        return IRREGULAR_NOUNS[word]
    if len(word) > 4 and word.endswith("ies"):
        return f"{word[:-3]}y"
    if len(word) > 4 and word.endswith("ves"):
        return _best_candidate((f"{word[:-3]}f", f"{word[:-3]}fe"), word)
    if len(word) > 4 and word.endswith(("ches", "shes", "sses", "xes", "zes")):
        return word[:-2]
    if len(word) > 3 and word.endswith("s") and not word.endswith(("ss", "us", "is", "ous")):
        return word[:-1]
    return word


def _verb_lemma(word: str) -> str:
    if word in IRREGULAR_VERBS:
        return IRREGULAR_VERBS[word]

    if len(word) > 5 and word.endswith("ying"):
        return f"{word[:-4]}ie"
    if len(word) > 4 and word.endswith("ing"):
        stem = word[:-3]
        return _best_candidate((stem, _strip_double_consonant(stem), f"{stem}e"), word)

    if len(word) > 4 and word.endswith("ied"):
        return f"{word[:-3]}y"
    if len(word) > 3 and word.endswith("ed"):
        stem = word[:-2]
        return _best_candidate((stem, _strip_double_consonant(stem), f"{stem}e"), word)

    if len(word) > 4 and word.endswith("ies"):
        return f"{word[:-3]}y"
    if len(word) > 3 and word.endswith("es"):
        stem = word[:-2]
        return _best_candidate(
            (stem, word[:-1], f"{stem}e"),
            word,
        )

    if len(word) > 3 and word.endswith("s") and not word.endswith(("ss", "us", "is", "ous")):
        return word[:-1]

    return word


def _adjective_lemma(word: str) -> str:
    if word in IRREGULAR_ADJECTIVES:
        return IRREGULAR_ADJECTIVES[word]
    if len(word) > 4 and word.endswith("iest"):
        return f"{word[:-4]}y"
    if len(word) > 3 and word.endswith("ier"):
        return f"{word[:-3]}y"
    if len(word) > 4 and word.endswith("est"):
        stem = word[:-3]
        return _best_candidate((stem, _strip_double_consonant(stem), f"{stem}e"), word)
    if len(word) > 3 and word.endswith("er"):
        stem = word[:-2]
        return _best_candidate((stem, _strip_double_consonant(stem), f"{stem}e"), word)
    return word


def _adverb_lemma(word: str) -> str:
    return IRREGULAR_ADVERBS.get(word, word)


def _suffix_pos_bonus(word: str, pos: str) -> float:
    if pos == "ADV":
        return 3.0 if word.endswith("ly") else -0.8

    if pos == "VERB":
        if word in IRREGULAR_VERBS:
            return 3.2
        if word.endswith(("ing", "ied", "ed", "en")):
            return 2.8
        if word.endswith(("ise", "ize", "ify", "ate")):
            return 1.8
        if word.endswith(("es", "s")):
            return 0.5
        return 0.2

    if pos == "NOUN":
        if word in IRREGULAR_NOUNS:
            return 3.2
        if word.endswith(("ies", "ves")) or (
            word.endswith("s") and not word.endswith(("ss", "us", "is", "ous"))
        ):
            return 2.6
        if word.endswith(NOUN_SUFFIXES):
            return 1.3
        return 0.5

    if pos == "ADJ":
        if word in IRREGULAR_ADJECTIVES:
            return 3.0
        if word.endswith(("ier", "iest", "er", "est")):
            return 2.3
        if word.endswith(ADJECTIVE_SUFFIXES):
            return 1.4
        return 0.4

    return -5.0


def _score_pos(surface: str, lemma: str, pos: str) -> float:
    if not WORD_RE.fullmatch(lemma):
        return float("-inf")

    lemma_zipf = zipf_frequency(lemma, "en")
    if lemma_zipf <= 0:
        return float("-inf")

    score = lemma_zipf * 3.5
    score += _suffix_pos_bonus(surface, pos)
    if lemma != surface:
        score += 0.35
    if len(lemma) < 3:
        score -= 4.0
    if len(lemma) > 16:
        score -= 2.5
    return score


class OfflineLemmaResolver:
    def __init__(self, preferred_model: str | None = None) -> None:
        self._nlp = None
        self.mode = "heuristic"
        model_candidates = [preferred_model] if preferred_model else list(DEFAULT_SPACY_MODELS)

        for model_name in model_candidates:
            if not model_name:
                continue
            try:
                self._nlp = spacy.load(
                    model_name,
                    disable=["parser", "ner", "textcat", "textcat_multilabel"],
                )
                self.mode = f"spacy_model:{model_name}"
                break
            except Exception:
                continue

    def analyze_words(self, words: Sequence[str]) -> Iterator[ResolvedToken]:
        if self._nlp is not None:
            yield from self._analyze_with_model(words)
            return

        for word in words:
            yield self._analyze_with_rules(word)

    def _analyze_with_model(self, words: Sequence[str]) -> Iterator[ResolvedToken]:
        assert self._nlp is not None
        for doc in self._nlp.pipe(words, batch_size=1024):
            if len(doc) != 1:
                surface = doc.text.lower()
                yield self._analyze_with_rules(surface)
                continue

            token = doc[0]
            surface = token.text.lower()
            pos = token.pos_ or None
            lemma = token.lemma_.lower().strip() if token.lemma_ else surface

            if pos == "PROPN":
                yield ResolvedToken(surface=surface, lemma=None, pos=pos, source=self.mode)
                continue

            if pos in LEXICAL_POS and WORD_RE.fullmatch(lemma):
                yield ResolvedToken(surface=surface, lemma=lemma, pos=pos, source=self.mode)
                continue

            yield self._analyze_with_rules(surface)

    def _analyze_with_rules(self, word: str) -> ResolvedToken:
        candidates = [
            ("VERB", _verb_lemma(word)),
            ("NOUN", _noun_lemma(word)),
            ("ADJ", _adjective_lemma(word)),
            ("ADV", _adverb_lemma(word)),
        ]
        scored = [
            (pos, lemma, _score_pos(word, lemma, pos))
            for pos, lemma in candidates
        ]
        scored = [item for item in scored if math.isfinite(item[2])]
        if not scored:
            return ResolvedToken(surface=word, lemma=None, pos="X", source="heuristic")

        scored.sort(
            key=lambda item: (-item[2], POS_PREFERENCE[item[0]], len(item[1]), item[1])
        )
        pos, lemma, _ = scored[0]
        return ResolvedToken(surface=word, lemma=lemma, pos=pos, source="heuristic")


def classify_allowed_exclusion(
    *,
    surface: str,
    lemma: str | None,
    pos: str | None,
    stopwords: set[str],
    profanity: set[str],
    exclude_profanity: bool,
) -> str | None:
    if not WORD_RE.fullmatch(surface):
        return "invalid_surface"
    if pos == "PROPN":
        return "proper_noun"
    if pos not in LEXICAL_POS:
        return f"filtered_pos:{(pos or 'UNKNOWN').lower()}"
    if not lemma or not WORD_RE.fullmatch(lemma):
        return "invalid_lemma"
    if len(lemma) < 3 or len(lemma) > 16:
        return "lemma_length"
    if lemma in stopwords:
        return "stopword"
    if exclude_profanity and lemma in profanity:
        return "profanity"
    return None


def classify_target_exclusion(
    *,
    word: str,
    profanity: set[str],
    stopwords: set[str],
    target_blocklist: set[str],
) -> str | None:
    if word in profanity:
        return "target_profanity"
    if word in stopwords:
        return "target_stopword"
    if word in target_blocklist:
        return "target_blocklist"
    if word in TARGET_HELPER_VERBS:
        return "target_helper_verb"
    if len(word) < 4 or len(word) > 12:
        return "target_length"
    return None


def score_target_word(
    *,
    word: str,
    profanity: set[str],
    stopwords: set[str],
    target_blocklist: set[str],
) -> float | None:
    rejection = classify_target_exclusion(
        word=word,
        profanity=profanity,
        stopwords=stopwords,
        target_blocklist=target_blocklist,
    )
    if rejection is not None:
        return None

    zipf = zipf_frequency(word, "en")
    if zipf < 3.6:
        return None

    score = 0.0
    score -= abs(zipf - 4.9) * 2.2

    length = len(word)
    if 5 <= length <= 8:
        score += 1.0
    elif 4 <= length <= 10:
        score += 0.45
    else:
        score -= 0.65

    if word.endswith(("tion", "sion", "ment", "ness", "ship", "ably", "edly")):
        score -= 0.5
    if word.endswith("ly"):
        score -= 0.3

    return score


def choose_targets(
    *,
    vocab: list[str],
    targets_size: int,
    profanity: set[str],
    stopwords: set[str],
    target_blocklist: set[str],
) -> list[str]:
    ranked_candidates: list[tuple[float, int, str]] = []
    for index, word in enumerate(vocab):
        score = score_target_word(
            word=word,
            profanity=profanity,
            stopwords=stopwords,
            target_blocklist=target_blocklist,
        )
        if score is None:
            continue
        ranked_candidates.append((score, -index, word))

    ranked_candidates.sort(reverse=True)
    selected = [word for _, _, word in ranked_candidates[:targets_size]]
    if len(selected) >= targets_size:
        return selected

    selected_set = set(selected)
    relaxed_candidates: list[tuple[float, int, str]] = []
    for index, word in enumerate(vocab):
        if word in selected_set:
            continue
        if classify_target_exclusion(
            word=word,
            profanity=profanity,
            stopwords=stopwords,
            target_blocklist=target_blocklist,
        ):
            continue

        relaxed_score = -abs(zipf_frequency(word, "en") - 4.7) * 1.6
        if 4 <= len(word) <= 10:
            relaxed_score += 0.5
        relaxed_candidates.append((relaxed_score, -index, word))

    relaxed_candidates.sort(reverse=True)
    selected.extend(word for _, _, word in relaxed_candidates[: max(0, targets_size - len(selected))])

    if len(selected) < targets_size:
        raise RuntimeError(
            f"Unable to build {targets_size} clean targets from allowed vocab; got {len(selected)}"
        )

    return selected[:targets_size]


def parse_fasttext_header(first_line: str) -> tuple[int | None, bool]:
    parts = first_line.strip().split()
    if len(parts) == 2 and parts[0].isdigit() and parts[1].isdigit():
        return int(parts[1]), True
    return None, False


def extract_vectors(
    *,
    fasttext_vec: Path,
    requested_words: set[str],
    existing_vectors: dict[str, np.ndarray] | None = None,
    expected_dim: int | None = None,
) -> tuple[dict[str, np.ndarray], int]:
    if not requested_words:
        if expected_dim is None:
            raise RuntimeError("expected_dim is required when no words are requested")
        return existing_vectors or {}, expected_dim

    vectors = dict(existing_vectors or {})
    dim = expected_dim
    remaining = set(requested_words) - set(vectors)

    with fasttext_vec.open("r", encoding="utf-8", errors="ignore") as stream:
        first_line = stream.readline()
        header_dim, has_header = parse_fasttext_header(first_line)
        if has_header:
            if dim is None:
                dim = header_dim
            elif header_dim is not None and dim != header_dim:
                raise RuntimeError(f"fastText dim mismatch: expected {dim}, got {header_dim}")
        else:
            stream.seek(0)

        if dim is None:
            raise RuntimeError("Unable to determine vector dimension from .vec file")

        for raw_line in stream:
            if not remaining:
                break

            line = raw_line.rstrip("\n")
            if not line:
                continue

            split_idx = line.find(" ")
            if split_idx <= 0:
                continue

            word = line[:split_idx]
            if word not in remaining:
                continue

            values = np.fromstring(line[split_idx + 1 :], sep=" ", dtype=np.float32)
            if values.size != dim:
                continue

            vectors[word] = values
            remaining.remove(word)

    return vectors, dim


def row_normalize(matrix: np.ndarray) -> np.ndarray:
    norms = np.linalg.norm(matrix, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    return matrix / norms


def ensure_sanity(
    *,
    allowed_vocab: list[str],
    targets: list[str],
    vectors: np.ndarray,
    word_index: dict[str, int],
    profanity: set[str],
    target_blocklist: set[str],
) -> None:
    if not allowed_vocab:
        raise RuntimeError("Sanity check failed: allowed vocab is empty")
    if not targets:
        raise RuntimeError("Sanity check failed: targets are empty")
    if vectors.shape[0] != len(allowed_vocab):
        raise RuntimeError(
            f"Sanity check failed: vector rows {vectors.shape[0]} != vocab {len(allowed_vocab)}"
        )
    if vectors.shape[1] != DEFAULT_VECTOR_DIM:
        raise RuntimeError(
            f"Sanity check failed: vector dim {vectors.shape[1]} != {DEFAULT_VECTOR_DIM}"
        )
    if len(word_index) != len(allowed_vocab):
        raise RuntimeError(
            f"Sanity check failed: word_index count {len(word_index)} != vocab {len(allowed_vocab)}"
        )

    vocab_set = set(allowed_vocab)
    if set(word_index) != vocab_set:
        raise RuntimeError("Sanity check failed: word_index keys do not match allowed vocab")
    if any(word not in vocab_set for word in targets):
        raise RuntimeError("Sanity check failed: targets contain words missing from allowed vocab")
    if any(word in profanity for word in targets):
        raise RuntimeError("Sanity check failed: profanity leaked into targets")
    if any(word in target_blocklist for word in targets):
        raise RuntimeError("Sanity check failed: target blocklist leaked into targets")
    if not all(WORD_RE.fullmatch(word) for word in allowed_vocab):
        raise RuntimeError("Sanity check failed: allowed vocab contains invalid tokens")


def build_clean_dictionary(
    *,
    fasttext_vec: Path,
    allowed_size: int,
    targets_size: int,
    profanity: set[str],
    stopwords: set[str],
    target_blocklist: set[str],
    surface_pool_size: int = DEFAULT_SURFACE_POOL_SIZE,
    vector_probe_factor: int = DEFAULT_VECTOR_PROBE_FACTOR,
    spacy_model: str | None = None,
    exclude_profanity_from_allowed: bool = True,
    debug_records: bool = True,
) -> BuildArtifacts:
    if allowed_size <= 0:
        raise ValueError("allowed_size must be positive")
    if targets_size <= 0:
        raise ValueError("targets_size must be positive")
    if surface_pool_size < allowed_size:
        raise ValueError("surface_pool_size must be at least allowed_size")

    resolver = OfflineLemmaResolver(preferred_model=spacy_model)
    source_words = top_n_list("en", surface_pool_size)

    lemma_entries: dict[str, LemmaEntry] = {}
    surface_records: list[SurfaceRecord] = []

    for surface, resolved in zip(source_words, resolver.analyze_words(source_words)):
        surface = surface.strip().lower()
        zipf = zipf_frequency(surface, "en")
        record = SurfaceRecord(
            surface=surface,
            lemma=resolved.lemma,
            pos=resolved.pos,
            frequency=zipf,
        )

        exclusion = classify_allowed_exclusion(
            surface=surface,
            lemma=resolved.lemma,
            pos=resolved.pos,
            stopwords=stopwords,
            profanity=profanity,
            exclude_profanity=exclude_profanity_from_allowed,
        )
        if exclusion is None and resolved.lemma is not None:
            entry = lemma_entries.get(resolved.lemma)
            if entry is None:
                entry = LemmaEntry(lemma=resolved.lemma)
                lemma_entries[resolved.lemma] = entry

            contribution = aggregate_frequency(zipf)
            entry.aggregate_frequency += contribution
            entry.best_surface_frequency = max(entry.best_surface_frequency, zipf)
            entry.surface_forms.add(surface)
            pos_key = resolved.pos or "NOUN"
            entry.pos_scores[pos_key] = entry.pos_scores.get(pos_key, 0.0) + contribution
            entry.dominant_pos = max(
                entry.pos_scores.items(),
                key=lambda item: (item[1], -POS_PREFERENCE.get(item[0], 99), item[0]),
            )[0]
        else:
            record.exclusion_reason = exclusion or "filtered"

        if debug_records:
            surface_records.append(record)

    ranked_lemmas = sorted(
        lemma_entries.values(),
        key=lambda entry: (-entry.aggregate_frequency, -entry.best_surface_frequency, entry.lemma),
    )
    if not ranked_lemmas:
        raise RuntimeError("No lemma candidates survived filtering")

    probe_count = min(
        len(ranked_lemmas),
        max(allowed_size * max(vector_probe_factor, 1), allowed_size),
    )
    vectors_by_word: dict[str, np.ndarray] = {}
    inferred_dim: int | None = None

    while True:
        requested_words = {entry.lemma for entry in ranked_lemmas[:probe_count]}
        vectors_by_word, inferred_dim = extract_vectors(
            fasttext_vec=fasttext_vec,
            requested_words=requested_words,
            existing_vectors=vectors_by_word,
            expected_dim=inferred_dim,
        )

        allowed_vocab = [
            entry.lemma for entry in ranked_lemmas if entry.lemma in vectors_by_word
        ][:allowed_size]
        if len(allowed_vocab) >= allowed_size or probe_count >= len(ranked_lemmas):
            break

        next_probe = min(len(ranked_lemmas), max(probe_count + 10_000, int(probe_count * 1.5)))
        if next_probe == probe_count:
            break
        probe_count = next_probe

    if len(allowed_vocab) < allowed_size:
        raise RuntimeError(
            f"Could not reach allowed vocab size {allowed_size}; only found {len(allowed_vocab)} "
            "clean lemmas with vectors. Increase --surface_pool_size or --vector_probe_factor."
        )

    if inferred_dim != DEFAULT_VECTOR_DIM:
        raise RuntimeError(
            f"Expected fastText dim {DEFAULT_VECTOR_DIM}, but file provides dim={inferred_dim}"
        )

    matrix = np.vstack([vectors_by_word[word] for word in allowed_vocab]).astype(np.float32, copy=False)
    matrix = row_normalize(matrix).astype("<f4", copy=False)

    word_index = {word: index for index, word in enumerate(allowed_vocab)}
    targets = choose_targets(
        vocab=allowed_vocab,
        targets_size=targets_size,
        profanity=profanity,
        stopwords=stopwords,
        target_blocklist=target_blocklist,
    )

    ensure_sanity(
        allowed_vocab=allowed_vocab,
        targets=targets,
        vectors=matrix,
        word_index=word_index,
        profanity=profanity,
        target_blocklist=target_blocklist,
    )

    if debug_records:
        allowed_set = set(allowed_vocab)
        target_set = set(targets)
        for record in surface_records:
            lemma = record.lemma or ""
            record.in_vectors = lemma in vectors_by_word
            record.kept_allowed = lemma in allowed_set
            record.kept_target = lemma in target_set

            if record.kept_target:
                record.exclusion_reason = ""
                continue

            if record.kept_allowed:
                record.exclusion_reason = (
                    classify_target_exclusion(
                        word=lemma,
                        profanity=profanity,
                        stopwords=stopwords,
                        target_blocklist=target_blocklist,
                    )
                    or "below_target_cutoff"
                )
                continue

            if not record.exclusion_reason:
                record.exclusion_reason = "no_vector" if lemma and lemma not in vectors_by_word else "below_allowed_cutoff"

    return BuildArtifacts(
        allowed_vocab=allowed_vocab,
        targets=targets,
        word_index=word_index,
        matrix=matrix,
        vectors_by_word=vectors_by_word,
        surface_records=surface_records,
        ranked_lemma_count=len(ranked_lemmas),
        resolver_mode=resolver.mode,
        surface_pool_size=surface_pool_size,
    )


def write_debug_csv(path: Path, surface_records: Sequence[SurfaceRecord]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as stream:
        writer = csv.writer(stream)
        writer.writerow(
            [
                "surface",
                "lemma",
                "pos",
                "frequency",
                "in_vectors",
                "kept_allowed",
                "kept_target",
                "exclusion_reason",
            ]
        )
        for record in surface_records:
            writer.writerow(
                [
                    record.surface,
                    record.lemma or "",
                    record.pos or "",
                    f"{record.frequency:.4f}",
                    int(record.in_vectors),
                    int(record.kept_allowed),
                    int(record.kept_target),
                    record.exclusion_reason,
                ]
            )
