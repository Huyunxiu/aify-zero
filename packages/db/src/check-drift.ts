/**
 * 断言 `src/schema` 与 `src/migrations` 同步。
 *
 * 迁移文件是表结构的唯一来源，所以「改了 schema 却忘了 `db:generate`」会让
 * 启动时的迁移无事可做，服务起来之后才在第一个请求里报 `no such column`。
 * 这个脚本在副本目录里跑一次生成：如果 drizzle 还能生成新的迁移，说明仓库里
 * 的迁移落后于 schema。同时校验 journal、SQL 与快照三者对得上——漏一个快照
 * 或者漏一条 journal，生成器就会从错误的版本算起。
 *
 * 用法：`vp run db#db:check`。接在 `vp ready` 里，不修改工作区。
 */
import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { cp, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  MIGRATIONS_DIRECTORY,
  SCHEMA_DIRECTORY,
  WORKSPACE_ROOT,
} from "./paths";

/**
 * 找到 drizzle-kit 的可执行入口。
 *
 * pnpm 把 bin 放在工作区根的 `node_modules/.bin`，包自己下面没有。`.bin`
 * 里是指向 `bin.cjs` 的符号链接，`realpathSync` 之后可以直接用 node 执行，
 * 不需要依赖 PATH 或 shell。
 */
const resolveDrizzleKit = (): string => {
  let directory = WORKSPACE_ROOT;

  for (;;) {
    const candidate = path.join(
      directory,
      "node_modules",
      ".bin",
      process.platform === "win32" ? "drizzle-kit.cmd" : "drizzle-kit"
    );

    if (existsSync(candidate)) {
      return realpathSync(candidate);
    }

    const parent = path.dirname(directory);

    if (parent === directory) {
      throw new Error("drizzle-kit is not installed. Run `vp install` first.");
    }

    directory = parent;
  }
};

const drizzleKit = resolveDrizzleKit();

/** 在副本目录里生成一次，输出只用来诊断失败原因。 */
const runGenerate = (cwd: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        drizzleKit,
        "generate",
        "--dialect",
        "turso",
        "--schema",
        SCHEMA_DIRECTORY,
        "--out",
        "./migrations",
      ],
      { cwd, stdio: ["ignore", "pipe", "pipe"] }
    );

    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolve(output);
        return;
      }

      reject(
        new Error(`drizzle-kit generate exited with code ${code}\n${output}`)
      );
    });
  });

const listByExtension = async (
  directory: string,
  extension: string
): Promise<string[]> => {
  const entries = await readdir(directory);

  return entries.filter((name) => name.endsWith(extension)).toSorted();
};

/**
 * journal、SQL 与快照必须一一对应。
 *
 * 生成器靠 journal 找快照来算下一个版本：少一条 journal 或多一个快照，它就会
 * 从一个错的版本开始 diff，产出的迁移可能是空的、也可能是错的。
 */
const findInconsistencies = async (): Promise<string[]> => {
  const journalPath = path.join(MIGRATIONS_DIRECTORY, "meta", "_journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf-8")) as {
    entries: { tag: string }[];
  };
  const migrations = await listByExtension(MIGRATIONS_DIRECTORY, ".sql");
  const snapshots = await listByExtension(
    path.join(MIGRATIONS_DIRECTORY, "meta"),
    "_snapshot.json"
  );
  const tags = journal.entries.map((entry) => entry.tag);
  const problems: string[] = [];

  for (const tag of tags) {
    if (!migrations.includes(`${tag}.sql`)) {
      problems.push(`journal lists ${tag} but its SQL file is missing`);
    }
  }

  for (const migration of migrations) {
    const tag = migration.replace(/\.sql$/, "");

    if (!tags.includes(tag)) {
      problems.push(`${migration} is not listed in the journal`);
    }
  }

  if (snapshots.length !== migrations.length) {
    problems.push(
      `meta holds ${snapshots.length} snapshot(s) for ${migrations.length} migration(s)`
    );
  }

  return problems;
};

const committed = await listByExtension(MIGRATIONS_DIRECTORY, ".sql");
const inconsistencies = await findInconsistencies();
const workDirectory = await mkdtemp(path.join(tmpdir(), "aify-db-check-"));

try {
  const scratch = path.join(workDirectory, "migrations");

  await cp(MIGRATIONS_DIRECTORY, scratch, { recursive: true });
  await runGenerate(workDirectory);

  const generated = await listByExtension(scratch, ".sql");
  const pending = generated.filter((name) => !committed.includes(name));

  if (pending.length > 0) {
    console.error(
      `[db] schema has changes without a migration: ${pending.join(", ")}`
    );
    console.error(
      "[db] run `vp run db#db:generate`, review the SQL, and commit it."
    );
  }

  for (const problem of inconsistencies) {
    console.error(`[db] migration files are inconsistent: ${problem}`);
  }

  if (pending.length > 0 || inconsistencies.length > 0) {
    process.exitCode = 1;
  } else {
    console.log(
      `[db] migrations match the schema (${committed.length} migration(s))`
    );
  }
} finally {
  await rm(workDirectory, { force: true, recursive: true });
}
