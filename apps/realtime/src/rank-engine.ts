import fs from "node:fs";
import path from "node:path";
import { WORD_REGEX } from "@word-hunt/shared";

type BuildRankMapResult = {
  targetWord: string;
  targetIndex: number;
  rankByIndex: Int32Array;
};

const PREFERRED_TARGET_POOL_SIZE = 1500;

export type EvaluatedGuess =
  | { ok: false; code: GuessValidationErrorCode; message: string }
  | { ok: true; word: string; rank: number; isCorrect: boolean };

function resolveDataFile(dataPath: string, candidates: string[]): string {
  for (const candidate of candidates) {
    const resolved = path.join(dataPath, candidate);
    if (fs.existsSync(resolved)) {
      return resolved;
    }
  }

  throw new Error(`Missing required data file. Tried: ${candidates.join(", ")}`);
}

function parseWordList(filePath: string): string[] {
  return fs
    .readFileSync(filePath, "utf8")
    .split(/\r?\n/u)
    .map((line) => line.trim().toLowerCase())
    .filter(Boolean);
}

function shuffleWords<T>(input: T[]): T[] {
  const words = [...input];
  for (let i = words.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const current = words[i];
    words[i] = words[j] as T;
    words[j] = current as T;
  }

  return words;
}

function hashSeed(seed: string): number {
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function isLikelyPluralWord(word: string): boolean {
  if (word.length < 4) {
    return false;
  }
  if (word.endsWith("ss") || word.endsWith("us") || word.endsWith("is") || word.endsWith("ous")) {
    return false;
  }
  if (word.endsWith("ies") || word.endsWith("ves")) {
    return true;
  }
  return word.endsWith("s");
}

function hasVowelSoundHint(word: string): boolean {
  return /[aeiouy]/u.test(word);
}

function isSoftRejectedTargetWord(word: string): boolean {
  if (word.length < 4 || word.length > 10) {
    return true;
  }
  if (word.length <= 5 && !hasVowelSoundHint(word)) {
    return true;
  }
  return isLikelyPluralWord(word);
}

function normalizeContextWord(word: string): string {
  return word
    .replace(/(ing|ers|ies|ied|ed|es|s)$/u, "")
    .replace(/(.)\1$/u, "$1");
}

function isTooSimilarContextWord(word: string, selected: string[]): boolean {
  const normalized = normalizeContextWord(word);
  return selected.some((existing) => {
    const other = normalizeContextWord(existing);
    if (normalized === other) {
      return true;
    }
    if (normalized.length >= 4 && other.length >= 4) {
      if (normalized.startsWith(other) || other.startsWith(normalized)) {
        return true;
      }
    }
    return false;
  });
}

export type GuessValidationErrorCode =
  | "INVALID_WORD_FORMAT"
  | "WORD_NOT_IN_DICTIONARY";

export class RankEngine {
  public readonly dictionaryVersion: string;

  public readonly vocab: string[];

  public readonly targets: string[];

  public readonly vectorDim: number;

  private readonly indexByWord: Map<string, number>;

  private readonly vectors: Float32Array;

  private readonly profanity: Set<string>;

  private readonly targetBlocklist: Set<string>;

  private readonly targetPool: string[];

  private readonly rankMapCache: Map<string, BuildRankMapResult>;

  private targetPoolCursor: number;

  constructor(input: {
    dataPath: string;
    dictionaryVersion: string;
    expectedVectorDim?: number;
  }) {
    this.dictionaryVersion = input.dictionaryVersion;

    const vocabPath = resolveDataFile(input.dataPath, [
      "vocab_100k_words.txt",
      "vocab_30k_words.txt",
      "vocab_100k_lemmas.txt",
      "vocab_30k_lemmas.txt"
    ]);
    const targetsPath = path.join(input.dataPath, "targets_10k.txt");
    const wordIndexPath = path.join(input.dataPath, "word_index.json");
    const vectorsPath = path.join(input.dataPath, "vectors.f32");
    const profanityPath = path.join(input.dataPath, "profanity.txt");
    const targetBlocklistPath = path.join(input.dataPath, "target_blocklist.txt");

    const requiredPaths = [vocabPath, targetsPath, wordIndexPath, vectorsPath];
    for (const requiredPath of requiredPaths) {
      if (!fs.existsSync(requiredPath)) {
        throw new Error(`Missing required data file: ${requiredPath}`);
      }
    }

    this.vocab = parseWordList(vocabPath);
    if (this.vocab.length === 0) {
      throw new Error("Vocabulary is empty");
    }

    this.profanity = fs.existsSync(profanityPath)
      ? new Set(parseWordList(profanityPath))
      : new Set();
    this.targetBlocklist = fs.existsSync(targetBlocklistPath)
      ? new Set(parseWordList(targetBlocklistPath))
      : new Set();

    const wordIndexRaw = JSON.parse(fs.readFileSync(wordIndexPath, "utf8")) as Record<
      string,
      number
    >;

    this.indexByWord = new Map<string, number>();
    for (const word of this.vocab) {
      const index = wordIndexRaw[word];
      if (index === undefined || index === null) {
        throw new Error(`word_index.json is missing vocab entry: ${word}`);
      }

      this.indexByWord.set(word, index);
    }

    // Runtime contract for vectors.f32:
    // - little-endian float32 values
    // - row-major layout
    // - no header, shape [vocab_size, vector_dim]
    const vectorBuffer = fs.readFileSync(vectorsPath);
    if (vectorBuffer.byteLength % 4 !== 0) {
      throw new Error("vectors.f32 byte length must be divisible by 4");
    }

    this.vectors = new Float32Array(
      vectorBuffer.buffer,
      vectorBuffer.byteOffset,
      vectorBuffer.byteLength / Float32Array.BYTES_PER_ELEMENT
    );

    const inferredDim = this.vectors.length / this.vocab.length;
    if (!Number.isInteger(inferredDim)) {
      throw new Error(
        `Vector size mismatch: vectorCount=${this.vectors.length} vocabSize=${this.vocab.length}`
      );
    }

    this.vectorDim = input.expectedVectorDim ?? inferredDim;
    if (this.vectorDim !== inferredDim) {
      throw new Error(`Expected vector dim ${this.vectorDim}, found ${inferredDim}`);
    }

    this.normalizeRows();

    const candidateTargets = [...new Set(parseWordList(targetsPath))].filter((word) => {
      return (
        this.indexByWord.has(word) &&
        !this.profanity.has(word) &&
        !this.targetBlocklist.has(word) &&
        !isSoftRejectedTargetWord(word)
      );
    });

    if (candidateTargets.length === 0) {
      throw new Error("No valid targets found after profanity/dictionary filtering");
    }

    const curatedTargets = candidateTargets.slice(0, Math.min(candidateTargets.length, PREFERRED_TARGET_POOL_SIZE));
    this.targets = curatedTargets;
    this.targetPool = shuffleWords(curatedTargets);
    this.rankMapCache = new Map();
    this.targetPoolCursor = 0;
  }

  validateGuess(word: string): { ok: true } | { ok: false; code: GuessValidationErrorCode; message: string } {
    if (!WORD_REGEX.test(word)) {
      return {
        ok: false,
        code: "INVALID_WORD_FORMAT",
        message: "Only one English word"
      };
    }

    if (!this.indexByWord.has(word)) {
      return {
        ok: false,
        code: "WORD_NOT_IN_DICTIONARY",
        message: "I don't know this word."
      };
    }

    return { ok: true };
  }

  buildRankMap(targetWord: string): BuildRankMapResult {
    const cached = this.rankMapCache.get(targetWord);
    if (cached) {
      return cached;
    }

    const targetIndex = this.indexByWord.get(targetWord);
    if (targetIndex === undefined) {
      throw new Error(`Target word is not in vocabulary: ${targetWord}`);
    }

    const targetOffset = targetIndex * this.vectorDim;
    const scoreEntries = new Array<{ index: number; score: number }>(this.vocab.length);

    for (let row = 0; row < this.vocab.length; row += 1) {
      const base = row * this.vectorDim;
      let dot = 0;
      for (let dim = 0; dim < this.vectorDim; dim += 1) {
        dot += (this.vectors[targetOffset + dim] ?? 0) * (this.vectors[base + dim] ?? 0);
      }
      scoreEntries[row] = { index: row, score: dot };
    }

    scoreEntries.sort((a, b) => {
      const scoreDelta = b.score - a.score;
      if (scoreDelta !== 0) {
        return scoreDelta;
      }
      return a.index - b.index;
    });
    const rankByIndex = new Int32Array(this.vocab.length);

    for (let i = 0; i < scoreEntries.length; i += 1) {
      const entry = scoreEntries[i];
      if (!entry) {
        continue;
      }
      rankByIndex[entry.index] = i + 1;
    }

    const result = { targetWord, targetIndex, rankByIndex };
    this.rankMapCache.set(targetWord, result);
    return result;
  }

  pickRandomTarget(): string {
    const nextTarget = this.targetPool[this.targetPoolCursor];
    if (!nextTarget) {
      throw new Error("No unused targets left. Rebuild targets or restart server.");
    }

    this.targetPoolCursor += 1;
    return nextTarget;
  }

  pickDailyTarget(seedDate: string): string {
    if (this.targets.length === 0) {
      throw new Error("No targets available for daily selection.");
    }

    const index = hashSeed(seedDate) % this.targets.length;
    const target = this.targets[index];
    if (!target) {
      throw new Error(`Could not resolve daily target for seed ${seedDate}`);
    }

    return target;
  }

  getRank(word: string, rankByIndex: Int32Array): number {
    const index = this.indexByWord.get(word);
    if (index === undefined) {
      throw new Error(`Cannot rank missing word: ${word}`);
    }

    return rankByIndex[index] ?? Number.MAX_SAFE_INTEGER;
  }

  evaluateGuess(rawWord: string, rankByIndex: Int32Array): EvaluatedGuess {
    const word = rawWord.trim().toLowerCase();
    const validation = this.validateGuess(word);
    if (!validation.ok) {
      return validation;
    }

    const rank = this.getRank(word, rankByIndex);
    return {
      ok: true,
      word,
      rank,
      isCorrect: rank === 1
    };
  }

  pickContextWords(rankByIndex: Int32Array, limit = 3): string[] {
    const desiredRanks = [30, 90, 220, 480, 900, 1600];
    const candidates: Array<{ word: string; rank: number }> = [];

    for (let index = 0; index < this.vocab.length; index += 1) {
      const word = this.vocab[index];
      const rank = rankByIndex[index];
      if (!word || !rank || rank <= 1 || rank > 4000) {
        continue;
      }
      if (this.profanity.has(word) || word.length < 4 || isLikelyPluralWord(word)) {
        continue;
      }

      candidates.push({ word, rank });
    }

    candidates.sort((a, b) => a.rank - b.rank);

    const selected: string[] = [];
    for (const desiredRank of desiredRanks) {
      let bestMatch: { word: string; rank: number } | null = null;
      let bestDistance = Number.POSITIVE_INFINITY;

      for (const candidate of candidates) {
        if (selected.includes(candidate.word) || isTooSimilarContextWord(candidate.word, selected)) {
          continue;
        }

        const distance = Math.abs(candidate.rank - desiredRank);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestMatch = candidate;
        }

        if (candidate.rank > desiredRank && distance > bestDistance) {
          break;
        }
      }

      if (bestMatch) {
        selected.push(bestMatch.word);
      }

      if (selected.length >= limit) {
        break;
      }
    }

    if (selected.length < limit) {
      for (const candidate of candidates) {
        if (selected.includes(candidate.word) || isTooSimilarContextWord(candidate.word, selected)) {
          continue;
        }
        selected.push(candidate.word);
        if (selected.length >= limit) {
          break;
        }
      }
    }

    return selected.slice(0, limit);
  }

  private normalizeRows(): void {
    for (let row = 0; row < this.vocab.length; row += 1) {
      const offset = row * this.vectorDim;
      let norm = 0;
      for (let dim = 0; dim < this.vectorDim; dim += 1) {
        const value = this.vectors[offset + dim] ?? 0;
        norm += value * value;
      }

      if (norm === 0) {
        continue;
      }

      const scale = 1 / Math.sqrt(norm);
      for (let dim = 0; dim < this.vectorDim; dim += 1) {
        this.vectors[offset + dim] = (this.vectors[offset + dim] ?? 0) * scale;
      }
    }
  }
}
