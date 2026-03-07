import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { config as loadEnv } from "dotenv";
import { Pool } from "pg";

declare global {
  // eslint-disable-next-line no-var
  var __wordHuntPrisma: PrismaClient | undefined;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Ensure DATABASE_URL is available even when this package is imported
// before app-specific env initialization (e.g. realtime server startup).
loadEnv({ path: path.resolve(__dirname, "../../.env") });
loadEnv();

function createClient(): PrismaClient {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required");
  }

  const pool = new Pool({
    connectionString
  });
  const adapter = new PrismaPg(pool);
  return new PrismaClient({ adapter });
}

export const prisma = globalThis.__wordHuntPrisma ?? createClient();

if (process.env.NODE_ENV !== "production") {
  globalThis.__wordHuntPrisma = prisma;
}
