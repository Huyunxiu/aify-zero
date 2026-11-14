/**
 * 把已有表结构的库标记为「迁移已应用到最新」，不重放任何 SQL。
 *
 * 只用于迁移历史为空、但表已经按当前 schema 建好的库——也就是 `db:push` 时代
 * 留下的开发库。正常情况下启动时的迁移会自己建表，这个脚本只会被手动调用
 * 一次。
 *
 * 标记之前先把迁移重放到一个临时库，比对两边的结构指纹：基线是「承认这个库
 * 就是迁移的产物」，不是「跳过检查」。结构不一致就拒绝，否则一个缺列的库会被
 * 标记成最新，从此再也不会被迁移。
 *
 * 用法：`vp run db#db:baseline`。默认操作 checkout 根部的 `local.db`，与
 * `drizzle.config.ts` 一致；操作别的库时用 `DATABASE_URL` 指过去。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";

import { resolveDevelopmentDatabaseUrl, WORKSPACE_ROOT } from "./paths";

// 先定库再加载数据层：`./index` 在导入时就按 `DATABASE_URL` 建连接。
process.env.DATABASE_URL = resolveDevelopmentDatabaseUrl(WORKSPACE_ROOT);

const {
  closeDb,
  countAppliedMigrations,
  db,
  listTables,
  migrateDb,
  MIGRATIONS_TABLE,
  MIGRATIONS_TABLE_DDL,
  readSchema,
  resolveDatabaseUrl,
  resolveMigrationsDirectory,
} = await import("./index");

const url = resolveDatabaseUrl();
const migrationsFolder = resolveMigrationsDirectory();
const migrations = readMigrationFiles({ migrationsFolder });

function fail(message: string): never {
  console.error(`[db] ${message}`);
  closeDb();
  process.exit(1);
}

/** 把迁移重放到一个临时库，得到「正确的结构」用来比对。 */
async function readMigratedSchema(): Promise<Map<string, string>> {
  const directory = await mkdtemp(path.join(tmpdir(), "aify-baseline-"));
  const client = createClient({
    url: `file:${path.join(directory, "expected.db")}`,
  });

  try {
    await migrate(drizzle({ client }), { migrationsFolder });

    return await readSchema(client);
  } finally {
    client.close();
    await rm(directory, { force: true, recursive: true });
  }
}

/** 两套结构指纹的差异；空数组表示结构一致。 */
function compareSchemas(
  expected: Map<string, string>,
  actual: Map<string, string>
): string[] {
  const differences: string[] = [];

  for (const table of new Set([...expected.keys(), ...actual.keys()])) {
    const want = expected.get(table);
    const have = actual.get(table);

    if (want === have) {
      continue;
    }

    if (have === undefined) {
      differences.push(`missing: ${table}`);
      continue;
    }

    if (want === undefined) {
      differences.push(`unexpected: ${table}`);
      continue;
    }

    const wanted = new Set(want.split(","));
    const present = new Set(have.split(","));
    const missing = [...wanted].filter((column) => !present.has(column));
    const extra = [...present].filter((column) => !wanted.has(column));

    differences.push(
      `differs: ${table} (missing ${missing.join(" / ") || "-"}; extra ${extra.join(" / ") || "-"})`
    );
  }

  return differences;
}

await db.$client.execute(MIGRATIONS_TABLE_DDL);

const appliedCount = await countAppliedMigrations();

if (appliedCount > 0) {
  fail(
    `${url} already has ${appliedCount} migration(s) applied; start the server instead of baselining.`
  );
}

// 全新库没有表：启动 server 就会迁移，基线在这里没有意义。
const tables = await listTables();

if (tables.length === 0) {
  fail(`${url} has no tables. Start the server to create and migrate it.`);
}

const differences = compareSchemas(
  await readMigratedSchema(),
  await readSchema()
);

if (differences.length > 0) {
  fail(
    `${url} does not match the migrations, so it cannot be baselined:\n  ${differences.slice(0, 10).join("\n  ")}\nDelete the file and start the server to rebuild it.`
  );
}

// 一次性写入全部历史：`created_at` 用 `_journal.json` 的 when，与 migrator 的
// 比较逻辑对齐；`hash` 用 `readMigrationFiles` 算出的值，不自己实现算法。
await db.$client.batch(
  migrations.map((migration) => ({
    args: [migration.hash, migration.folderMillis],
    sql: `insert into "${MIGRATIONS_TABLE}" ("hash", "created_at") values (?, ?)`,
  })),
  "write"
);

// 用真正的入口验一遍：它应该无事可做。
await migrateDb();

console.log(
  `[db] baselined ${migrations.length} migration(s) for ${url} (${await countAppliedMigrations()} recorded)`
);

closeDb();
