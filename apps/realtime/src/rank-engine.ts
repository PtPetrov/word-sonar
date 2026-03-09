import fs from "node:fs";
import path from "node:path";
import { WORD_REGEX } from "@word-hunt/shared";

type BuildRankMapResult = {
  targetWord: string;
  targetIndex: number;
  rankByIndex: Int32Array;
};

type RankEngineAssets = {
  vocab: string[];
  targets: string[];
  vectorDim: number;
  resolvedDataPrefix: string;
  indexByWord: Map<string, number>;
  vectors: Float32Array;
  profanity: Set<string>;
  resolvedFiles: {
    vocabPath: string;
    targetsPath: string;
    wordIndexPath: string;
    vectorsPath: string;
  };
  approximateBytes: {
    vectors: number;
    targetOrder: number;
  };
};

type RankEngineDiagnostics = {
  vocabCount: number;
  targetCount: number;
  vectorDim: number;
  vectorBytes: number;
  targetOrderBytes: number;
  dataPath: string;
  dataPrefix: string;
  vocabPath: string;
  targetsPath: string;
  vectorsPath: string;
};

type ResolvedVectorSource = {
  resolvedPath: string;
  partPaths?: string[];
  filePath?: string;
};

type ResolvedAssetBundle = {
  dataPrefix: string;
  vocabPath: string;
  targetsPath: string;
  wordIndexPath: string;
  profanityPath: string | null;
  vectorSource: ResolvedVectorSource;
};

export type EvaluatedGuess =
  | { ok: false; code: GuessValidationErrorCode; message: string }
  | { ok: true; word: string; rank: number; isCorrect: boolean };

const GLOBAL_ASSET_CACHE_KEY = "__wordHuntRankEngineAssetCache__";
const DAILY_RANK_CACHE_MAX_ENTRIES = 2;

function getGlobalAssetCache(): Map<string, RankEngineAssets> {
  const globalCache = globalThis as typeof globalThis & {
    [GLOBAL_ASSET_CACHE_KEY]?: Map<string, RankEngineAssets>;
  };

  if (!globalCache[GLOBAL_ASSET_CACHE_KEY]) {
    globalCache[GLOBAL_ASSET_CACHE_KEY] = new Map<string, RankEngineAssets>();
  }

  return globalCache[GLOBAL_ASSET_CACHE_KEY];
}

function prefixedCandidates(prefix: string, candidates: string[], allowUnprefixedFallback = true): string[] {
  if (!prefix) {
    return candidates;
  }

  if (!allowUnprefixedFallback) {
    return candidates.map((candidate) => `${prefix}${candidate}`);
  }

  return [...candidates.map((candidate) => `${prefix}${candidate}`), ...candidates];
}

function resolveDataFile(dataPath: string, candidates: string[], prefix = "", allowUnprefixedFallback = true): string {
  const resolved = maybeResolveDataFile(dataPath, candidates, prefix, allowUnprefixedFallback);
  if (resolved) {
    return resolved;
  }

  throw new Error(
    `Missing required data file. Tried: ${prefixedCandidates(prefix, candidates, allowUnprefixedFallback).join(", ")}`
  );
}

function maybeResolveDataFile(
  dataPath: string,
  candidates: string[],
  prefix = "",
  allowUnprefixedFallback = true
): string | null {
  for (const candidate of prefixedCandidates(prefix, candidates, allowUnprefixedFallback)) {
    const resolved = path.join(dataPath, candidate);
    if (fs.existsSync(resolved)) {
      return resolved;
    }
  }

  return null;
}

function maybeResolveAllowedVocabFile(dataPath: string, prefix = "", allowUnprefixedFallback = true): string | null {
  const preferred = path.join(dataPath, `${prefix}allowed_vocab.txt`);
  if (fs.existsSync(preferred)) {
    return preferred;
  }

  if (prefix && allowUnprefixedFallback) {
    const unprefixed = path.join(dataPath, "allowed_vocab.txt");
    if (fs.existsSync(unprefixed)) {
      return unprefixed;
    }
  }

  const vocabFilePriority = (fileName: string): number => {
    const match = /^vocab_(\d+)(k)?_(lemmas|words)\.txt$/u.exec(fileName);
    if (!match) {
      return 0;
    }

    const rawSize = Number.parseInt(match[1] ?? "0", 10);
    const size = match[2] ? rawSize * 1_000 : rawSize;
    const lemmaBonus = match[3] === "lemmas" ? 1 : 0;
    return size * 10 + lemmaBonus;
  };

  const fallbackCandidates = fs
    .readdirSync(dataPath)
    .filter((fileName) => {
      if (prefix && !allowUnprefixedFallback && !fileName.startsWith(prefix)) {
        return false;
      }
      const normalized = prefix && fileName.startsWith(prefix) ? fileName.slice(prefix.length) : fileName;
      return /^vocab_\d+[k\d]*_(lemmas|words)\.txt$/u.test(normalized);
    })
    .sort((left, right) => {
      const normalizedLeft = prefix && left.startsWith(prefix) ? left.slice(prefix.length) : left;
      const normalizedRight = prefix && right.startsWith(prefix) ? right.slice(prefix.length) : right;
      const priorityDelta = vocabFilePriority(normalizedRight) - vocabFilePriority(normalizedLeft);
      if (priorityDelta !== 0) {
        return priorityDelta;
      }
      return left.localeCompare(right, undefined, { numeric: true });
    });

  const chosen = fallbackCandidates[0];
  if (!chosen) {
    return null;
  }

  return path.join(dataPath, chosen);
}

function resolveAllowedVocabFile(dataPath: string, prefix = "", allowUnprefixedFallback = true): string {
  const resolved = maybeResolveAllowedVocabFile(dataPath, prefix, allowUnprefixedFallback);
  if (resolved) {
    return resolved;
  }

  throw new Error("Missing required allowed vocab file.");
}

function parseWordList(filePath: string): string[] {
  return fs
    .readFileSync(filePath, "utf8")
    .split(/\r?\n/u)
    .map((line) => line.trim().toLowerCase())
    .filter(Boolean);
}

function isGitLfsPointerFile(filePath: string): boolean {
  if (!fs.existsSync(filePath)) {
    return false;
  }

  const stats = fs.statSync(filePath);
  if (stats.size > 512) {
    return false;
  }

  const contents = fs.readFileSync(filePath, "utf8");
  return contents.startsWith("version https://git-lfs.github.com/spec/v1");
}

function maybeResolveVectorSource(
  dataPath: string,
  prefix = "",
  allowUnprefixedFallback = true
): ResolvedVectorSource | null {
  const preferred = path.join(dataPath, `${prefix}vectors.f32`);
  if (fs.existsSync(preferred) && !isGitLfsPointerFile(preferred)) {
    return { filePath: preferred, resolvedPath: preferred };
  }

  const splitPattern = prefix
    ? new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}vectors\\.f32\\.part\\d+$`, "u")
    : /^vectors\.f32\.part\d+$/u;
  const splitPartPaths = fs
    .readdirSync(dataPath)
    .filter((fileName) => splitPattern.test(fileName))
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }))
    .map((fileName) => path.join(dataPath, fileName));

  if (splitPartPaths.length > 0) {
    return { partPaths: splitPartPaths, resolvedPath: splitPartPaths.join(",") };
  }

  if (prefix && !allowUnprefixedFallback) {
    return null;
  }

  const fallback = path.join(dataPath, "vectors.f32");
  if (fs.existsSync(fallback) && !isGitLfsPointerFile(fallback)) {
    return { filePath: fallback, resolvedPath: fallback };
  }

  return null;
}

function readVectorBuffer(
  dataPath: string,
  prefix = "",
  allowUnprefixedFallback = true
): { buffer: Buffer; resolvedPath: string } {
  const source = maybeResolveVectorSource(dataPath, prefix, allowUnprefixedFallback);
  if (!source) {
    throw new Error(
      `Missing required vector data. Tried: ${prefixedCandidates(prefix, ["vectors.f32", "vectors.f32.partN"], allowUnprefixedFallback).join(", ")}`
    );
  }

  if (source.partPaths) {
    return {
      buffer: Buffer.concat(source.partPaths.map((filePath) => fs.readFileSync(filePath))),
      resolvedPath: source.resolvedPath
    };
  }

  return {
    buffer: fs.readFileSync(source.filePath ?? ""),
    resolvedPath: source.resolvedPath
  };
}

function maybeResolveAssetBundle(dataPath: string, prefix = ""): ResolvedAssetBundle | null {
  const vocabPath = maybeResolveAllowedVocabFile(dataPath, prefix, false);
  const targetsPath = maybeResolveDataFile(dataPath, ["targets.txt", "targets_10k.txt"], prefix, false);
  const wordIndexPath = maybeResolveDataFile(dataPath, ["word_index.json"], prefix, false);
  const vectorSource = maybeResolveVectorSource(dataPath, prefix, false);

  if (!vocabPath || !targetsPath || !wordIndexPath || !vectorSource) {
    return null;
  }

  return {
    dataPrefix: prefix,
    vocabPath,
    targetsPath,
    wordIndexPath,
    profanityPath: maybeResolveDataFile(dataPath, ["profanity.txt"], prefix, false),
    vectorSource
  };
}

function resolveAssetBundle(dataPath: string, prefix = ""): ResolvedAssetBundle {
  const prefixedBundle = prefix ? maybeResolveAssetBundle(dataPath, prefix) : null;
  if (prefixedBundle) {
    return prefixedBundle;
  }

  const unprefixedBundle = maybeResolveAssetBundle(dataPath, "");
  if (unprefixedBundle) {
    return unprefixedBundle;
  }

  resolveAllowedVocabFile(dataPath, prefix);
  resolveDataFile(dataPath, ["targets.txt", "targets_10k.txt"], prefix);
  resolveDataFile(dataPath, ["word_index.json"], prefix);
  readVectorBuffer(dataPath, prefix);

  throw new Error("Could not resolve a dictionary asset bundle.");
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

function shuffleIndices(size: number): number[] {
  return shuffleWords(Array.from({ length: size }, (_, index) => index));
}

function normalizeRows(vectors: Float32Array, vocabLength: number, vectorDim: number): void {
  for (let row = 0; row < vocabLength; row += 1) {
    const offset = row * vectorDim;
    let norm = 0;
    for (let dim = 0; dim < vectorDim; dim += 1) {
      const value = vectors[offset + dim] ?? 0;
      norm += value * value;
    }

    if (norm === 0) {
      continue;
    }

    const scale = 1 / Math.sqrt(norm);
    for (let dim = 0; dim < vectorDim; dim += 1) {
      vectors[offset + dim] = (vectors[offset + dim] ?? 0) * scale;
    }
  }
}

function loadRankEngineAssets(input: {
  dataPath: string;
  dataPrefix?: string;
  expectedVectorDim?: number;
}): RankEngineAssets {
  const dataPrefix = input.dataPrefix ?? "";
  const cacheKey = `${input.dataPath}|${dataPrefix}|${input.expectedVectorDim ?? "auto"}`;
  const assetCache = getGlobalAssetCache();
  const cached = assetCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const bundle = resolveAssetBundle(input.dataPath, dataPrefix);
  const {
    vocabPath,
    targetsPath,
    wordIndexPath,
    profanityPath,
    vectorSource
  } = bundle;

  const vocab = parseWordList(vocabPath);
  if (vocab.length === 0) {
    throw new Error("Vocabulary is empty");
  }

  const targets = [...new Set(parseWordList(targetsPath))];
  if (targets.length === 0) {
    throw new Error("No targets found in targets file");
  }

  const profanity = profanityPath && fs.existsSync(profanityPath)
    ? new Set(parseWordList(profanityPath))
    : new Set<string>();

  const wordIndexRaw = JSON.parse(fs.readFileSync(wordIndexPath, "utf8")) as Record<string, number>;
  const indexByWord = new Map<string, number>();
  for (const word of vocab) {
    const index = wordIndexRaw[word];
    if (index === undefined || index === null) {
      throw new Error(`word_index.json is missing vocab entry: ${word}`);
    }
    indexByWord.set(word, index);
  }

  for (const word of targets) {
    if (!indexByWord.has(word)) {
      throw new Error(`Target word is not in allowed vocab: ${word}`);
    }
  }

  const { buffer: vectorBuffer, resolvedPath: vectorsPath } = vectorSource.partPaths
    ? {
        buffer: Buffer.concat(vectorSource.partPaths.map((filePath) => fs.readFileSync(filePath))),
        resolvedPath: vectorSource.resolvedPath
      }
    : {
        buffer: fs.readFileSync(vectorSource.filePath ?? ""),
        resolvedPath: vectorSource.resolvedPath
      };
  if (vectorBuffer.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) {
    throw new Error("vectors.f32 byte length must be divisible by 4");
  }

  const vectors = new Float32Array(
    vectorBuffer.buffer,
    vectorBuffer.byteOffset,
    vectorBuffer.byteLength / Float32Array.BYTES_PER_ELEMENT
  );

  const inferredDim = vectors.length / vocab.length;
  if (!Number.isInteger(inferredDim)) {
    throw new Error(`Vector size mismatch: vectorCount=${vectors.length} vocabSize=${vocab.length}`);
  }

  const vectorDim = input.expectedVectorDim ?? inferredDim;
  if (vectorDim !== inferredDim) {
    throw new Error(`Expected vector dim ${vectorDim}, found ${inferredDim}`);
  }

  normalizeRows(vectors, vocab.length, vectorDim);

  const assets: RankEngineAssets = {
    vocab,
    targets,
    vectorDim,
    resolvedDataPrefix: bundle.dataPrefix,
    indexByWord,
    vectors,
    profanity,
    resolvedFiles: {
      vocabPath,
      targetsPath,
      wordIndexPath,
      vectorsPath
    },
    approximateBytes: {
      vectors: vectorBuffer.byteLength,
      targetOrder: targets.length * Uint32Array.BYTES_PER_ELEMENT
    }
  };

  assetCache.set(cacheKey, assets);
  return assets;
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
  | "WORD_NOT_IN_DICTIONARY"
  | "PROFANITY_NOT_ALLOWED";

export class RankEngine {
  public readonly dictionaryVersion: string;

  public readonly vocab: string[];

  public readonly targets: string[];

  public readonly vectorDim: number;

  public readonly diagnostics: RankEngineDiagnostics;

  private readonly indexByWord: Map<string, number>;

  private readonly vectors: Float32Array;

  private readonly profanity: Set<string>;

  private readonly targetOrder: number[];

  private readonly dailyRankMapCache: Map<string, BuildRankMapResult>;

  private targetPoolCursor: number;

  constructor(input: {
    dataPath: string;
    dataPrefix?: string;
    dictionaryVersion: string;
    expectedVectorDim?: number;
  }) {
    this.dictionaryVersion = input.dictionaryVersion;

    const assets = loadRankEngineAssets({
      dataPath: input.dataPath,
      dataPrefix: input.dataPrefix,
      expectedVectorDim: input.expectedVectorDim
    });

    this.vocab = assets.vocab;
    this.targets = assets.targets;
    this.vectorDim = assets.vectorDim;
    this.indexByWord = assets.indexByWord;
    this.vectors = assets.vectors;
    this.profanity = assets.profanity;
    this.targetOrder = shuffleIndices(this.targets.length);
    this.dailyRankMapCache = new Map<string, BuildRankMapResult>();
    this.targetPoolCursor = 0;
    this.diagnostics = {
      vocabCount: this.vocab.length,
      targetCount: this.targets.length,
      vectorDim: this.vectorDim,
      vectorBytes: assets.approximateBytes.vectors,
      targetOrderBytes: assets.approximateBytes.targetOrder,
      dataPath: input.dataPath,
      dataPrefix: assets.resolvedDataPrefix,
      vocabPath: assets.resolvedFiles.vocabPath,
      targetsPath: assets.resolvedFiles.targetsPath,
      vectorsPath: assets.resolvedFiles.vectorsPath
    };
  }

  validateGuess(word: string): { ok: true } | { ok: false; code: GuessValidationErrorCode; message: string } {
    if (!WORD_REGEX.test(word)) {
      return {
        ok: false,
        code: "INVALID_WORD_FORMAT",
        message: "Use a single common English word"
      };
    }

    if (!this.indexByWord.has(word)) {
      return {
        ok: false,
        code: "WORD_NOT_IN_DICTIONARY",
        message: "Not in dictionary"
      };
    }

    if (this.profanity.has(word)) {
      return {
        ok: false,
        code: "PROFANITY_NOT_ALLOWED",
        message: "That word is blocked"
      };
    }

    return { ok: true };
  }

  buildRankMap(targetWord: string): BuildRankMapResult {
    const targetIndex = this.indexByWord.get(targetWord);
    if (targetIndex === undefined) {
      throw new Error(`Target word is not in vocabulary: ${targetWord}`);
    }

    const vocabLength = this.vocab.length;
    const targetOffset = targetIndex * this.vectorDim;
    const scores = new Float32Array(vocabLength);
    const sortedIndices = new Uint32Array(vocabLength);

    for (let row = 0; row < vocabLength; row += 1) {
      const base = row * this.vectorDim;
      let dot = 0;
      for (let dim = 0; dim < this.vectorDim; dim += 1) {
        dot += (this.vectors[targetOffset + dim] ?? 0) * (this.vectors[base + dim] ?? 0);
      }
      scores[row] = dot;
      sortedIndices[row] = row;
    }

    sortedIndices.sort((left, right) => {
      const scoreDelta = (scores[right] ?? 0) - (scores[left] ?? 0);
      if (scoreDelta !== 0) {
        return scoreDelta;
      }
      return left - right;
    });
    const rankByIndex = new Int32Array(vocabLength);

    for (let i = 0; i < sortedIndices.length; i += 1) {
      rankByIndex[sortedIndices[i] ?? 0] = i + 1;
    }

    return { targetWord, targetIndex, rankByIndex };
  }

  buildDailyRankMap(seedDate: string): BuildRankMapResult {
    const cached = this.dailyRankMapCache.get(seedDate);
    if (cached) {
      return cached;
    }

    const result = this.buildRankMap(this.pickDailyTarget(seedDate));
    this.dailyRankMapCache.set(seedDate, result);

    while (this.dailyRankMapCache.size > DAILY_RANK_CACHE_MAX_ENTRIES) {
      const oldestKey = this.dailyRankMapCache.keys().next().value;
      if (oldestKey === undefined) {
        break;
      }
      this.dailyRankMapCache.delete(oldestKey);
    }

    return result;
  }

  pickRandomTarget(): string {
    const nextIndex = this.targetOrder[this.targetPoolCursor];
    if (nextIndex === undefined) {
      throw new Error("No unused targets left. Rebuild targets or restart server.");
    }

    const nextTarget = this.targets[nextIndex];
    if (!nextTarget) {
      throw new Error(`Missing target for shuffled index ${nextIndex}`);
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

  getDailyCacheSize(): number {
    return this.dailyRankMapCache.size;
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
}
