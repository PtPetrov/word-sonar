import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";

loadEnv();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function parseIntWithDefault(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

const dictionaryMode = process.env.DICTIONARY_MODE ?? (process.env.NODE_ENV === "development" ? "dev" : "prod");
const dataPrefix =
  process.env.DATA_PREFIX ??
  (dictionaryMode === "dev" ? "dev_" : "");

export const serverConfig = {
  port: parseIntWithDefault(process.env.PORT, 4001),
  corsOrigin: process.env.CORS_ORIGIN ?? "*",
  turnMsDefault: parseIntWithDefault(process.env.TURN_MS_DEFAULT, 15_000),
  countdownSeconds: parseIntWithDefault(process.env.COUNTDOWN_SECONDS, 5),
  dictionaryVersion:
    process.env.DICTIONARY_VERSION ?? "v2_clean_lemmas_40k_2026_03_placeholder",
  dataPath: process.env.DATA_PATH ?? path.resolve(__dirname, "../../../data"),
  dataPrefix,
  dictionaryMode,
  vectorDim: process.env.VECTOR_DIM ? Number.parseInt(process.env.VECTOR_DIM, 10) : undefined,
  reconnectGraceMs: parseIntWithDefault(process.env.RECONNECT_GRACE_MS, 30_000),
  dailyTimezone: "Europe/Sofia",
  logMemory: parseBoolean(process.env.LOG_MEMORY, false)
} as const;
