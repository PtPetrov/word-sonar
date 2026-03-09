#!/usr/bin/env python3
"""Build clean lemma-only dictionary assets for runtime."""

from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from pathlib import Path

from dictionary_pipeline import (
    DEFAULT_SURFACE_POOL_SIZE,
    DEFAULT_VECTOR_DIM,
    DEFAULT_VECTOR_PROBE_FACTOR,
    build_clean_dictionary,
    load_stopwords,
    load_target_blocklist,
    read_word_list,
    write_debug_csv,
    write_text_list,
    WORD_RE,
)

DEFAULT_ALLOWED_SIZE = 40_000
DEFAULT_TARGETS_SIZE = 10_000
DEFAULT_DEBUG_FILENAME = "debug/lemmatized_candidates.csv"


@dataclass(frozen=True)
class PipelineConfig:
    fasttext_vec: Path
    out_dir: Path
    allowed_size: int
    targets_size: int
    profanity_file: Path
    stopwords_file: Path | None
    timezone: str
    surface_pool_size: int
    vector_probe_factor: int
    spacy_model: str | None
    include_profanity_in_allowed: bool
    debug_csv_path: Path | None


def parse_args() -> PipelineConfig:
    default_profanity = Path(__file__).resolve().parent / "profanity" / "en.txt"

    parser = argparse.ArgumentParser(
        description="Create allowed_vocab.txt, targets.txt, word_index.json, vectors.f32, and debug CSV"
    )
    parser.add_argument("--fasttext_vec", type=Path, required=True)
    parser.add_argument("--out_dir", type=Path, required=True)
    parser.add_argument("--allowed_size", type=int, default=DEFAULT_ALLOWED_SIZE)
    parser.add_argument("--targets_size", type=int, default=DEFAULT_TARGETS_SIZE)
    parser.add_argument("--profanity_file", type=Path, default=default_profanity)
    parser.add_argument("--stopwords_file", type=Path, default=None)
    parser.add_argument("--timezone", type=str, default="Europe/Sofia")
    parser.add_argument("--surface_pool_size", type=int, default=DEFAULT_SURFACE_POOL_SIZE)
    parser.add_argument("--vector_probe_factor", type=int, default=DEFAULT_VECTOR_PROBE_FACTOR)
    parser.add_argument("--spacy_model", type=str, default=None)
    parser.add_argument(
        "--include_profanity_in_allowed",
        action="store_true",
        help="Keep profanity in allowed guesses. Default is a clean allowed vocab.",
    )
    parser.add_argument(
        "--debug_csv",
        type=Path,
        default=None,
        help=f"Optional debug CSV path. Defaults to <out_dir>/{DEFAULT_DEBUG_FILENAME}. Use --no_debug_csv to disable.",
    )
    parser.add_argument("--no_debug_csv", action="store_true")

    args = parser.parse_args()
    if args.allowed_size <= 0:
        raise ValueError("--allowed_size must be positive")
    if args.targets_size <= 0:
        raise ValueError("--targets_size must be positive")
    if args.surface_pool_size <= 0:
        raise ValueError("--surface_pool_size must be positive")
    if args.vector_probe_factor <= 0:
        raise ValueError("--vector_probe_factor must be positive")

    debug_csv_path = (
        None
        if args.no_debug_csv
        else args.debug_csv or args.out_dir / DEFAULT_DEBUG_FILENAME
    )
    return PipelineConfig(
        fasttext_vec=args.fasttext_vec,
        out_dir=args.out_dir,
        allowed_size=args.allowed_size,
        targets_size=args.targets_size,
        profanity_file=args.profanity_file,
        stopwords_file=args.stopwords_file,
        timezone=args.timezone,
        surface_pool_size=args.surface_pool_size,
        vector_probe_factor=args.vector_probe_factor,
        spacy_model=args.spacy_model,
        include_profanity_in_allowed=args.include_profanity_in_allowed,
        debug_csv_path=debug_csv_path,
    )


def main() -> None:
    config = parse_args()

    if not config.fasttext_vec.exists():
        raise FileNotFoundError(f"fastText .vec file not found: {config.fasttext_vec}")
    if config.fasttext_vec.suffix != ".vec":
        raise RuntimeError("Expected --fasttext_vec to point to an unzipped .vec file")

    config.out_dir.mkdir(parents=True, exist_ok=True)

    stopwords = load_stopwords(config.stopwords_file)
    profanity = {
        word for word in read_word_list(config.profanity_file) if WORD_RE.fullmatch(word)
    }
    target_blocklist = load_target_blocklist(config.out_dir)

    artifacts = build_clean_dictionary(
        fasttext_vec=config.fasttext_vec,
        allowed_size=config.allowed_size,
        targets_size=config.targets_size,
        profanity=profanity,
        stopwords=stopwords,
        target_blocklist=target_blocklist,
        surface_pool_size=config.surface_pool_size,
        vector_probe_factor=config.vector_probe_factor,
        spacy_model=config.spacy_model,
        exclude_profanity_from_allowed=not config.include_profanity_in_allowed,
        debug_records=config.debug_csv_path is not None,
    )

    allowed_vocab_path = config.out_dir / "allowed_vocab.txt"
    targets_path = config.out_dir / "targets.txt"
    word_index_path = config.out_dir / "word_index.json"
    vectors_path = config.out_dir / "vectors.f32"
    debug_csv_path = config.debug_csv_path

    write_text_list(allowed_vocab_path, artifacts.allowed_vocab)
    write_text_list(targets_path, artifacts.targets)
    word_index_path.write_text(
        json.dumps(artifacts.word_index, ensure_ascii=True),
        encoding="utf-8",
    )
    artifacts.matrix.tofile(vectors_path)

    if debug_csv_path is not None:
        write_debug_csv(debug_csv_path, artifacts.surface_records)

    expected_vector_bytes = (
        len(artifacts.allowed_vocab)
        * DEFAULT_VECTOR_DIM
        * artifacts.matrix.dtype.itemsize
    )
    actual_vector_bytes = vectors_path.stat().st_size
    if actual_vector_bytes != expected_vector_bytes:
        raise RuntimeError(
            f"vectors.f32 byte size mismatch: {actual_vector_bytes} != {expected_vector_bytes}"
        )

    print("Dictionary build complete")
    print(f"  timezone_hint: {config.timezone}")
    print(f"  resolver_mode: {artifacts.resolver_mode}")
    print(f"  source_surface_pool: {artifacts.surface_pool_size}")
    print(f"  ranked_lemma_count: {artifacts.ranked_lemma_count}")
    print(f"  allowed_vocab_count: {len(artifacts.allowed_vocab)} -> {allowed_vocab_path}")
    print(f"  targets_count: {len(artifacts.targets)} -> {targets_path}")
    print(f"  target_blocklist_count: {len(target_blocklist)}")
    print(f"  stopwords_count: {len(stopwords)}")
    print(f"  word_index_count: {len(artifacts.word_index)} -> {word_index_path}")
    print(f"  vector_dim: {DEFAULT_VECTOR_DIM}")
    print(f"  vectors_shape: {artifacts.matrix.shape[0]} x {artifacts.matrix.shape[1]}")
    print(f"  vectors_bytes: {actual_vector_bytes} -> {vectors_path}")
    if debug_csv_path is not None:
        print(f"  debug_csv: {debug_csv_path}")


if __name__ == "__main__":
    main()
