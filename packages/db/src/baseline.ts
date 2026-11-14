/**
 * 把已有表结构的库标记为「迁移已应用到最新」，不重放任何 SQL。
 *
 * 只用于迁移历史为空、但表已经按当前 schema 建好的库——也就是 `db:push` 时代
 * 留下的开发库。正常情况下启动时的迁移会自己建表，这个脚本只会被手动调用
 * 一次。
 *
 * 用法：`vp run db#db:baseline`。默认操作 checkout 根部的 `local.db`，与
 * `drizzle.config.ts` 一致；操作别的库时用 `DATABASE_URL` 指过去。
 */
import path from "node:path";

import { readMigrationFiles } from "drizzle-orm/migrator";

// 先定库再加载数据层：`./index` 在导入时就按 `DATABASE_URL` 建连接。
const checkoutRoot = path.resolve(import.meta.dirname, "..", "..", "..");

if (process.env.DATABASE_URL === undefined || process.env.DATABASE_URL === "") {
  process.env.DATABASE_URL = `file:${path.join(checkoutRoot, "local.db")}`;
}

const {
  closeDb,
  db,
  MIGRATIONS_TABLE,
  migrateDb,
  resolveDatabaseUrl,
  resolveMigrationsDirectory,
} = await import("./index");

/** 与 drizzle 的 migrator 建出的历史表保持一致，否则它的查询读不到。 */
const migrationsTableDdl = `create table if not exists "${MIGRATIONS_TABLE}" (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)`;

const url = resolveDatabaseUrl();
const migrations = readMigrationFiles({
  migrationsFolder: resolveMigrationsDirectory(),
});

function fail(message: string): never {
  console.error(`[db] ${message}`);
  closeDb();
  process.exit(1);
}

await db.$client.execute(migrationsTableDdl);

const applied = await db.$client.execute(
  `select count(*) as applied from ${MIGRATIONS_TABLE}`
);
const appliedCount = Number(applied.rows[0]?.applied ?? 0);

if (appliedCount > 0) {
  fail(
    `${url} already has ${appliedCount} migration(s) applied; start the server instead of baselining.`
  );
}

// 全新库没有表：启动 server 就会迁移，基线在这里没有意义。
const probe = await db.$client.execute(
  "select count(*) as found from sqlite_master where type = 'table' and name = 'session'"
);

if (Number(probe.rows[0]?.found ?? 0) === 0) {
  fail(`${url} has no tables. Start the server to create and migrate it.`);
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

const verified = await db.$client.execute(
  `select count(*) as applied from ${MIGRATIONS_TABLE}`
);

console.log(
  `[db] baselined ${migrations.length} migration(s) for ${url} (${Number(verified.rows[0]?.applied ?? 0)} recorded)`
);

closeDb();
