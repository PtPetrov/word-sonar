#!/usr/bin/env python3
"""Rebuild targets.txt from an existing allowed vocab file and target policy."""

from __future__ import annotations

import argparse
from pathlib import Path

from dictionary_pipeline import (
    choose_targets,
    load_stopwords,
    load_target_blocklist,
    read_word_list,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Rebuild targets.txt using the current clean target policy"
    )
    parser.add_argument(
        "--vocab_file",
        type=Path,
        default=Path("data/allowed_vocab.txt"),
    )
    parser.add_argument(
        "--out_file",
        type=Path,
        default=Path("data/targets.txt"),
    )
    parser.add_argument(
        "--profanity_file",
        type=Path,
        default=Path("data/profanity.txt"),
    )
    parser.add_argument(
        "--stopwords_file",
        type=Path,
        default=None,
    )
    parser.add_argument(
        "--targets_size",
        type=int,
        default=10_000,
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()

    vocab = read_word_list(args.vocab_file)
    profanity = set(read_word_list(args.profanity_file))
    target_blocklist = load_target_blocklist(args.out_file.parent)
    stopwords = load_stopwords(args.stopwords_file)

    targets = choose_targets(
        vocab=vocab,
        targets_size=args.targets_size,
        profanity=profanity,
        stopwords=stopwords,
        target_blocklist=target_blocklist,
    )

    args.out_file.write_text("".join(f"{word}\n" for word in targets), encoding="utf-8")

    print("Targets rebuilt")
    print(f"  vocab_file: {args.vocab_file}")
    print(f"  out_file: {args.out_file}")
    print(f"  targets_count: {len(targets)}")
    print(f"  target_blocklist_count: {len(target_blocklist)}")


if __name__ == "__main__":
    main()
