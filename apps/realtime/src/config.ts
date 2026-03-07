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

export const serverConfig = {
  port: parseIntWithDefault(process.env.PORT, 4001),
  corsOrigin: process.env.CORS_ORIGIN ?? "*",
  turnMsDefault: parseIntWithDefault(process.env.TURN_MS_DEFAULT, 15_000),
  countdownSeconds: parseIntWithDefault(process.env.COUNTDOWN_SECONDS, 5),
  dictionaryVersion:
    process.env.DICTIONARY_VERSION ?? "v1_100k_words_2026_03_placeholder",
  dataPath: process.env.DATA_PATH ?? path.resolve(__dirname, "../../../data"),
  vectorDim: process.env.VECTOR_DIM ? Number.parseInt(process.env.VECTOR_DIM, 10) : undefined,
  reconnectGraceMs: parseIntWithDefault(process.env.RECONNECT_GRACE_MS, 30_000),
  dailyTimezone: "Europe/Sofia"
} as const;
