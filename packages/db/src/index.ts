import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { createClient } from "@libsql/client";
import dotenv from "dotenv";
import { drizzle } from "drizzle-orm/libsql";
import Database from "libsql";

import * as schema from "./schema";

dotenv.config();

// Ensure the ~/.aify-zero user data directory exists.
const ensureDataDir = () => {
  const dataDir = path.join(homedir(), ".aify-zero");

  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }

  return dataDir;
};

export function createDb() {
  const dataDir = ensureDataDir();
  const url =
    process.env.DATABASE_URL ?? `file:${path.join(dataDir, "aify-zero.db")}`;
  // create db file if not exists
  const db = new Database(url);
  const client = createClient({
    url,
  });

  return drizzle({ client, schema });
}

export const db = createDb();

export * from "./schema";
