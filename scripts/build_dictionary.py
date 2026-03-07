#!/usr/bin/env python3
"""Build surface-form dictionary and fastText vector assets for runtime."""

from __future__ import annotations

import argparse
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

import numpy as np
from spacy.lang.en.stop_words import STOP_WORDS
from wordfreq import top_n_list, zipf_frequency

WORD_RE = re.compile(r"^[a-z]+$")
DEFAULT_DIM = 300
DEFAULT_VOCAB_SIZE = 100_000
DEFAULT_TARGETS_SIZE = 10_000
TARGET_BLOCKLIST_FILENAME = "target_blocklist.txt"


@dataclass(frozen=True)
class PipelineConfig:
    fasttext_vec: Path
    out_dir: Path
    vocab_size: int
    targets_size: int
    profanity_file: Path
    timezone: str


def parse_args() -> PipelineConfig:
    default_profanity = Path(__file__).resolve().parent / "profanity" / "en.txt"

    parser = argparse.ArgumentParser(
        description="Create vocab_*_words.txt, targets_10k.txt, word_index.json and vectors.f32"
    )
    parser.add_argument("--fasttext_vec", type=Path, required=True)
    parser.add_argument("--out_dir", type=Path, required=True)
    parser.add_argument("--vocab_size", type=int, default=DEFAULT_VOCAB_SIZE)
    parser.add_argument("--targets_size", type=int, default=DEFAULT_TARGETS_SIZE)
    parser.add_argument("--profanity_file", type=Path, default=default_profanity)
    parser.add_argument("--timezone", type=str, default="Europe/Sofia")

    args = parser.parse_args()
    if args.vocab_size <= 0:
        raise ValueError("--vocab_size must be positive")
    if args.targets_size <= 0:
        raise ValueError("--targets_size must be positive")

    return PipelineConfig(
        fasttext_vec=args.fasttext_vec,
        out_dir=args.out_dir,
        vocab_size=args.vocab_size,
        targets_size=args.targets_size,
        profanity_file=args.profanity_file,
        timezone=args.timezone,
    )


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


def load_target_blocklist(out_dir: Path) -> set[str]:
    blocklist_path = out_dir / TARGET_BLOCKLIST_FILENAME
    if not blocklist_path.exists():
        return set()
    return {
        word
        for word in read_word_list(blocklist_path)
        if WORD_RE.fullmatch(word)
    }


def is_likely_plural_word(word: str) -> bool:
    if len(word) < 4:
        return False
    if word.endswith(("ss", "us", "is", "ous")):
        return False
    if word.endswith(("ies", "ves")):
        return True
    return word.endswith("s")


def has_vowel_sound_hint(word: str) -> bool:
    return any(char in "aeiouy" for char in word)


def is_hard_rejected_target_word(
    *,
    word: str,
    profanity: set[str],
    stopwords: set[str],
    target_blocklist: set[str],
) -> bool:
    if len(word) < 4 or len(word) > 10:
        return True
    if word in profanity or word in stopwords or word in target_blocklist:
        return True
    if is_likely_plural_word(word):
        return True
    if len(word) <= 5 and not has_vowel_sound_hint(word):
        return True
    return False


def is_soft_rejected_target_word(
    *,
    word: str,
    profanity: set[str],
    stopwords: set[str],
    target_blocklist: set[str],
) -> bool:
    if is_hard_rejected_target_word(
        word=word,
        profanity=profanity,
        stopwords=stopwords,
        target_blocklist=target_blocklist,
    ):
        return True

    zipf = zipf_frequency(word, "en")
    if zipf < 4.35 or zipf > 5.45:
        return True

    return False


def score_target_word(
    *,
    word: str,
    profanity: set[str],
    stopwords: set[str],
    target_blocklist: set[str],
) -> float | None:
    if is_soft_rejected_target_word(
        word=word,
        profanity=profanity,
        stopwords=stopwords,
        target_blocklist=target_blocklist,
    ):
        return None

    zipf = zipf_frequency(word, "en")
    length = len(word)
    score = 0.0

    # Bias toward broadly familiar words, but avoid the most trivial ones.
    score -= abs(zipf - 4.85) * 2.4

    if 5 <= length <= 8:
        score += 1.1
    elif length in (4, 9, 10):
        score += 0.4
    else:
        score -= 1.0

    if word.endswith(("ing", "tion", "ment", "ness", "ship", "less", "ally", "ized", "ised")):
        score -= 0.8
    elif word.endswith(("ity", "ism", "ist")):
        score -= 0.35

    return score


def extend_ranked_words(
    *,
    pool_size: int,
    processed_word_count: int,
    ranked_words: list[str],
    seen_words: set[str],
) -> int:
    source_words = top_n_list("en", pool_size)
    new_words = source_words[processed_word_count:]
    if not new_words:
        return len(source_words)

    for raw_word in new_words:
        word = raw_word.strip().lower()
        if not WORD_RE.fullmatch(word):
            continue
        if word in seen_words:
            continue

        seen_words.add(word)
        ranked_words.append(word)

    return len(source_words)


def parse_fasttext_header(first_line: str) -> tuple[int | None, bool]:
    parts = first_line.strip().split()
    if len(parts) == 2 and parts[0].isdigit() and parts[1].isdigit():
        return int(parts[1]), True
    return None, False


def extract_vectors(
    *,
    fasttext_vec: Path,
    requested_words: set[str],
    existing_vectors: dict[str, np.ndarray],
    expected_dim: int | None,
) -> tuple[dict[str, np.ndarray], int]:
    if not requested_words:
        if expected_dim is None:
            raise RuntimeError("Internal error: expected_dim is missing")
        return existing_vectors, expected_dim

    vectors = dict(existing_vectors)
    dim = expected_dim

    with fasttext_vec.open("r", encoding="utf-8", errors="ignore") as stream:
        first_line = stream.readline()
        header_dim, has_header = parse_fasttext_header(first_line)
        if has_header:
            if dim is None:
                dim = header_dim
            elif header_dim is not None and dim != header_dim:
                raise RuntimeError(
                    f"fastText dim mismatch between scans: {dim} != {header_dim}"
                )
        else:
            stream.seek(0)

        if dim is None:
            raise RuntimeError("Unable to determine vector dimension from .vec file")

        remaining = set(requested_words)
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

            raw_values = line[split_idx + 1 :]
            values = np.fromstring(raw_values, sep=" ", dtype=np.float32)
            if values.size != dim:
                continue

            vectors[word] = values
            remaining.remove(word)

    return vectors, dim


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
    selected_words = [word for _, _, word in ranked_candidates]
    if len(selected_words) >= targets_size:
        return selected_words[:targets_size]

    selected_set = set(selected_words)
    relaxed_candidates: list[tuple[float, int, str]] = []
    for index, word in enumerate(vocab):
        if word in selected_set:
            continue
        if is_hard_rejected_target_word(
            word=word,
            profanity=profanity,
            stopwords=stopwords,
            target_blocklist=target_blocklist,
        ):
            continue

        zipf = zipf_frequency(word, "en")
        relaxed_score = -abs(zipf - 4.8) * 1.6
        if 5 <= len(word) <= 8:
            relaxed_score += 0.7
        relaxed_candidates.append((relaxed_score, -index, word))

    relaxed_candidates.sort(reverse=True)
    selected_words.extend(word for _, _, word in relaxed_candidates)

    if len(selected_words) < targets_size:
        raise RuntimeError(
            f"Unable to build {targets_size} targets after filtering; got {len(selected_words)}"
        )

    return selected_words[:targets_size]


def row_normalize(matrix: np.ndarray) -> np.ndarray:
    norms = np.linalg.norm(matrix, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    return matrix / norms


def ensure_sanity(
    *,
    vocab: list[str],
    targets: list[str],
    vectors: np.ndarray,
    word_index: dict[str, int],
    profanity: set[str],
    target_blocklist: set[str],
    vocab_size: int,
    targets_size: int,
) -> None:
    if len(vocab) != vocab_size:
        raise RuntimeError(f"Sanity check failed: vocab count {len(vocab)} != {vocab_size}")
    if len(targets) != targets_size:
        raise RuntimeError(
            f"Sanity check failed: targets count {len(targets)} != {targets_size}"
        )
    if vectors.shape != (vocab_size, DEFAULT_DIM):
        raise RuntimeError(
            f"Sanity check failed: vectors shape {vectors.shape} != ({vocab_size}, {DEFAULT_DIM})"
        )
    if len(word_index) != vocab_size:
        raise RuntimeError(
            f"Sanity check failed: word_index count {len(word_index)} != {vocab_size}"
        )

    vocab_set = set(vocab)
    if set(word_index) != vocab_set:
        raise RuntimeError("Sanity check failed: word_index keys do not match vocab words")
    if any(word not in vocab_set for word in targets):
        raise RuntimeError("Sanity check failed: targets contain words missing from vocab")
    if any(word in profanity for word in targets):
        raise RuntimeError("Sanity check failed: profanity leaked into targets")
    if any(word in target_blocklist for word in targets):
        raise RuntimeError("Sanity check failed: blocklisted words leaked into targets")
    if not all(WORD_RE.fullmatch(word) for word in vocab):
        raise RuntimeError("Sanity check failed: vocab contains invalid tokens")


def write_text_list(path: Path, words: Iterable[str]) -> None:
    path.write_text("".join(f"{word}\n" for word in words), encoding="utf-8")


def vocab_filename_for_size(vocab_size: int) -> str:
    if vocab_size % 1_000 == 0:
        return f"vocab_{vocab_size // 1_000}k_words.txt"
    return f"vocab_{vocab_size}_words.txt"


def main() -> None:
    config = parse_args()

    if not config.fasttext_vec.exists():
        raise FileNotFoundError(f"fastText .vec file not found: {config.fasttext_vec}")
    if config.fasttext_vec.suffix != ".vec":
        raise RuntimeError("Expected --fasttext_vec to point to an unzipped .vec file")

    config.out_dir.mkdir(parents=True, exist_ok=True)

    stopwords = {word.lower() for word in STOP_WORDS}
    profanity = {
        word
        for word in read_word_list(config.profanity_file)
        if WORD_RE.fullmatch(word)
    }
    target_blocklist = load_target_blocklist(config.out_dir)

    ranked_words: list[str] = []
    seen_words: set[str] = set()
    vectors_by_word: dict[str, np.ndarray] = {}
    processed_source_word_count = 0
    inferred_dim: int | None = None

    vocab: list[str] = []
    pool_size = max(config.vocab_size * 8, 120_000)
    max_pool_size = max(config.vocab_size * 80, 2_000_000)

    while True:
        previous_processed_count = processed_source_word_count
        processed_source_word_count = extend_ranked_words(
            pool_size=pool_size,
            processed_word_count=processed_source_word_count,
            ranked_words=ranked_words,
            seen_words=seen_words,
        )

        missing = set(ranked_words) - set(vectors_by_word)
        vectors_by_word, inferred_dim = extract_vectors(
            fasttext_vec=config.fasttext_vec,
            requested_words=missing,
            existing_vectors=vectors_by_word,
            expected_dim=inferred_dim,
        )

        vocab = [word for word in ranked_words if word in vectors_by_word][: config.vocab_size]
        if len(vocab) == config.vocab_size:
            break

        reached_source_limit = (
            pool_size >= max_pool_size and processed_source_word_count == previous_processed_count
        )
        if reached_source_limit:
            break

        next_pool_size = min(max_pool_size, int(pool_size * 1.5))
        if next_pool_size == pool_size:
            next_pool_size = min(max_pool_size, pool_size + 50_000)
        pool_size = next_pool_size

    if len(vocab) != config.vocab_size:
        raise RuntimeError(
            f"Could not reach vocab size {config.vocab_size}; collected {len(vocab)} words with vectors. "
            "Increase candidate pools in scripts/build_dictionary.py."
        )

    if inferred_dim != DEFAULT_DIM:
        raise RuntimeError(
            f"Expected fastText dim {DEFAULT_DIM}, but file provides dim={inferred_dim}"
        )

    matrix = np.vstack([vectors_by_word[word] for word in vocab]).astype(np.float32, copy=False)
    matrix = row_normalize(matrix).astype("<f4", copy=False)

    word_index = {word: i for i, word in enumerate(vocab)}
    targets = choose_targets(
        vocab=vocab,
        targets_size=config.targets_size,
        profanity=profanity,
        stopwords=stopwords,
        target_blocklist=target_blocklist,
    )

    ensure_sanity(
        vocab=vocab,
        targets=targets,
        vectors=matrix,
        word_index=word_index,
        profanity=profanity,
        target_blocklist=target_blocklist,
        vocab_size=config.vocab_size,
        targets_size=config.targets_size,
    )

    vocab_path = config.out_dir / vocab_filename_for_size(config.vocab_size)
    targets_path = config.out_dir / "targets_10k.txt"
    word_index_path = config.out_dir / "word_index.json"
    vectors_path = config.out_dir / "vectors.f32"

    write_text_list(vocab_path, vocab)
    write_text_list(targets_path, targets)
    word_index_path.write_text(json.dumps(word_index, ensure_ascii=True), encoding="utf-8")
    matrix.tofile(vectors_path)

    expected_vector_bytes = config.vocab_size * DEFAULT_DIM * np.dtype("<f4").itemsize
    actual_vector_bytes = vectors_path.stat().st_size
    if actual_vector_bytes != expected_vector_bytes:
        raise RuntimeError(
            f"vectors.f32 byte size mismatch: {actual_vector_bytes} != {expected_vector_bytes}"
        )

    print("Dictionary build complete")
    print(f"  timezone_hint: {config.timezone}")
    print(f"  vocab_count: {len(vocab)} -> {vocab_path}")
    print(f"  targets_count: {len(targets)} -> {targets_path}")
    print(f"  target_blocklist_count: {len(target_blocklist)}")
    print(f"  word_index_count: {len(word_index)} -> {word_index_path}")
    print(f"  vector_dim: {DEFAULT_DIM}")
    print(f"  vectors_shape: {matrix.shape[0]} x {matrix.shape[1]}")
    print(f"  vectors_bytes: {actual_vector_bytes} -> {vectors_path}")


if __name__ == "__main__":
    main()
