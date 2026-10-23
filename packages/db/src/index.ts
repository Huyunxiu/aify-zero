import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { createClient } from "@libsql/client";
import dotenv from "dotenv";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
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
  // libsql 只在真正连接时才建文件；开一个句柄再立刻关掉，让 drizzle 和
  // 迁移在首次运行时能打开一个已存在的库，而不是泄漏一个永不关闭的连接。
  if (url.startsWith("file:")) {
    const bootstrap = new Database(url);
    bootstrap.close();
  }
  const client = createClient({
    url,
  });

  return drizzle({ client, schema });
}

export const db = createDb();

/**
 * 应用数据库的迁移入口。
 *
 * 打包后的应用没有仓库里的 `.env`，数据库默认落在
 * `~/.aify-zero/aify-zero.db`，首次启动必须自己建表。迁移目录由桌面
 * 主进程通过 `AIFY_MIGRATIONS_DIR` 指定（打包后是 `Resources/migrations`）。
 *
 * 迁移是幂等的：drizzle 用 `__drizzle_migrations` 记录已应用的版本。
 */
export async function migrateDb(): Promise<void> {
  const migrationsFolder = process.env.AIFY_MIGRATIONS_DIR;

  if (migrationsFolder === undefined || migrationsFolder === "") {
    throw new Error("AIFY_MIGRATIONS_DIR is not set");
  }

  await migrate(db, { migrationsFolder });
}

export * from "./schema";
