import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import type { Client } from "@libsql/client";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import Database from "libsql";

import { findMigrationsDirectory } from "./paths";
import * as schema from "./schema";
import { serializeClient } from "./serialize-client";

// 环境变量由进程入口加载：`dotenv.config()` 会按 cwd 找 `.env`，让同一个
// 数据层在仓库根、`apps/server`、打包后的资源目录下连到不同的库。

/** drizzle 的 migrator 记录已应用迁移的表；基线脚本必须写同一个表。 */
export const MIGRATIONS_TABLE = "__drizzle_migrations";

/** 历史表的建表语句，与 drizzle 的 migrator 写下的完全一致。 */
export const MIGRATIONS_TABLE_DDL = `create table if not exists "${MIGRATIONS_TABLE}" (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)`;

// Ensure the ~/.aify-zero user data directory exists.
const ensureDataDir = () => {
  const dataDir = path.join(homedir(), ".aify-zero");

  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }

  return dataDir;
};

/**
 * 解析数据库地址：显式 `DATABASE_URL` 优先，否则落在 `~/.aify-zero/aify-zero.db`。
 *
 * 开发期的进程入口会先把 `DATABASE_URL` 指到 checkout 根部的 `local.db`，所以
 * 同一个表达式在开发态和打包态各自命中正确的文件。空字符串按「没有设置」
 * 处理：`.env` 里留一行空的 `DATABASE_URL=` 不应该变成一个空地址。
 */
export function resolveDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;

  if (url !== undefined && url !== "") {
    return url;
  }

  return `file:${path.join(ensureDataDir(), "aify-zero.db")}`;
}

export function createDb() {
  const url = resolveDatabaseUrl();
  // libsql 只在真正连接时才建文件；开一个句柄再立刻关掉，让 drizzle 和
  // 迁移在首次运行时能打开一个已存在的库，而不是泄漏一个永不关闭的连接。
  if (url.startsWith("file:")) {
    const bootstrap = new Database(url);
    bootstrap.close();
  }
  // 本地文件才排队：libsql 的事务会给并发查询另开一条连接，同一个文件上两条
  // 写连接会立刻 SQLITE_BUSY；远端服务端本来就能并发，不需要这把锁。
  const raw = createClient({ url });
  const client = url.startsWith("file:") ? serializeClient(raw) : raw;

  return drizzle({ client, schema });
}

export const db = createDb();

/**
 * 关闭底层 libsql 连接。
 *
 * server 收到 SIGTERM 时先停监听、再关数据库，最后才退出；否则进程被
 * `process.exit()` 直接带走，WAL 文件和连接句柄都只能交给操作系统回收。
 */
export function closeDb(): void {
  db.$client.close();
}

/**
 * 迁移文件目录。
 *
 * 默认取本模块附近带 `meta/_journal.json` 的 `migrations/`：源码态是
 * `packages/db/src/migrations`；`apps/server` 的构建产物由
 * `scripts/stage-server-dist.ts` 复制到 `dist/migrations`，而打包器把本模块
 * 放进 `dist/assets/`，所以两个位置都要能命中。只有代码被打包搬离自己的目录
 * 时才需要覆盖——Electron 的 server 入口在 `.vite/build` 里运行，主进程会用
 * `AIFY_MIGRATIONS_DIR` 指定 `Resources/migrations`。
 */
export function resolveMigrationsDirectory(): string {
  const override = process.env.AIFY_MIGRATIONS_DIR;

  if (override !== undefined && override !== "") {
    return override;
  }

  // 打包器会把本模块放进 `<out>/assets/`，所以「同级」要向上找一层；源码态
  // 第一层就命中，循环立刻结束。
  return (
    findMigrationsDirectory(import.meta.dirname) ??
    path.join(import.meta.dirname, "migrations")
  );
}

/**
 * 把 libsql 的单元格转成指纹里的一段文本。
 *
 * 列可能为 NULL（例如 `dflt_value`），统一记成空串，免得和字符串 "null" 混淆。
 */
const cell = (value: unknown): string => {
  if (value === null || value === undefined) {
    return "";
  }

  return typeof value === "string" ? value : JSON.stringify(value);
};

/** 业务表清单，不含 SQLite 内部表和迁移历史表。 */
export async function listTables(
  client: Client = db.$client
): Promise<string[]> {
  const result = await client.execute(
    `select name from sqlite_master where type = 'table' and name not like 'sqlite%' and name <> '${MIGRATIONS_TABLE}' order by name`
  );

  return result.rows.map((row) => cell(row.name));
}

/** 统计已应用的迁移条数；历史表不存在时算 0 条。 */
export async function countAppliedMigrations(
  client: Client = db.$client
): Promise<number> {
  try {
    const result = await client.execute(
      `select count(*) as applied from ${MIGRATIONS_TABLE}`
    );

    return Number(result.rows[0]?.applied ?? 0);
  } catch (error) {
    // 只有「表还不存在」算空历史。锁冲突之类的失败必须抛出去，否则会被当成
    // 「这个库没有迁移历史」，给出错误的修复指令。
    const message = error instanceof Error ? error.message : String(error);

    if (message.includes("no such table")) {
      return 0;
    }

    throw error;
  }
}

/**
 * 结构指纹：每张表记录「列名|类型|非空|默认值|主键」，外加索引清单。
 *
 * 基线要回答的问题是「这个库和迁移文件产出的结构是不是同一个」，所以指纹
 * 按列比对，不比建表语句的文本——`db:push` 与 migrator 写下的 SQL 排版不同，
 * 但结构可以完全一致。
 */
export async function readSchema(
  client: Client = db.$client
): Promise<Map<string, string>> {
  const fingerprint = new Map<string, string>();

  for (const table of await listTables(client)) {
    const columns = await client.execute(`pragma table_info("${table}")`);

    fingerprint.set(
      table,
      columns.rows
        .map((row) =>
          [row.name, row.type, row.notnull, row.dflt_value, row.pk]
            .map((value) => cell(value))
            .join("|")
        )
        .join(",")
    );
  }

  const indexes = await client.execute(
    "select name, tbl_name from sqlite_master where type = 'index' and name not like 'sqlite%' order by name"
  );

  fingerprint.set(
    "indexes",
    indexes.rows
      .map((row) => `${cell(row.name)}@${cell(row.tbl_name)}`)
      .join(",")
  );

  return fingerprint;
}

/** 给迁移失败补上库地址；跨进程争用要能一眼看出是别人在迁移。 */
const migrationFailure = (error: unknown, url: string): Error => {
  const message = error instanceof Error ? error.message : String(error);

  if (
    message.includes("SQLITE_BUSY") ||
    message.includes("database is locked")
  ) {
    return new Error(
      `Migration for ${url} failed: another process is migrating the same database. Stop it and start again.`,
      { cause: error }
    );
  }

  return new Error(`Migration for ${url} failed: ${message}`, { cause: error });
};

/**
 * 应用数据库的迁移入口。
 *
 * 迁移文件是表结构的唯一来源：开发态和打包后的应用启动时都走这里，不再有
 * 第二条建表路径。迁移是幂等的：drizzle 用 `__drizzle_migrations` 记录已应用
 * 的版本，重复调用只会补上还没应用的部分。
 *
 * 迁移目录和数据库地址都不对时立刻抛错——表结构是启动的前置条件，在结构漂移
 * 的库上提供服务只会把错误推迟到第一个请求。
 */
export async function migrateDb(): Promise<void> {
  const migrationsFolder = resolveMigrationsDirectory();
  const journalPath = path.join(migrationsFolder, "meta", "_journal.json");

  if (!existsSync(journalPath)) {
    throw new Error(
      `Migration files are missing at ${migrationsFolder}. Run \`vp install\`, then start again.`
    );
  }

  const url = resolveDatabaseUrl();

  // 空历史 + 有表 = 这个库由 `db:push` 或更早的版本建过，重放迁移会和已有表
  // 冲突。基线只能由人执行一次，不能在这里自动做：自动基线等于把「结构漂移」
  // 也一起标记成「已应用」。
  const [appliedMigrations, tables] = await Promise.all([
    countAppliedMigrations(),
    listTables(),
  ]);

  if (appliedMigrations === 0 && tables.length > 0) {
    throw new Error(
      `Database ${url} has tables but no migration history. Run \`vp run db#db:baseline\` from a repository checkout to mark the existing schema as applied, or delete the file and start again to rebuild it.`
    );
  }

  try {
    await migrate(db, { migrationsFolder });
  } catch (error) {
    throw migrationFailure(error, url);
  }
}

export * from "./schema";
