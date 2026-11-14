/**
 * 断言 `src/schema` 与 `src/migrations` 同步。
 *
 * 迁移文件是表结构的唯一来源，所以「改了 schema 却忘了 `db:generate`」会让
 * 启动时的迁移无事可做，服务起来之后才在第一个请求里报 `no such column`。
 * 这个脚本在副本目录里跑一次生成：如果 drizzle 还能生成新的迁移，说明仓库里
 * 的迁移落后于 schema。
 *
 * 用法：`vp run db#db:check`。接在 `vp ready` 里，不修改工作区。
 */
import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const packageDirectory = path.resolve(import.meta.dirname, "..");
const schemaDirectory = path.join(packageDirectory, "src", "schema");
const migrationsDirectory = path.join(packageDirectory, "src", "migrations");

/**
 * 找到 drizzle-kit 的可执行入口。
 *
 * pnpm 把 bin 放在工作区根的 `node_modules/.bin`，包自己下面没有。`.bin`
 * 里是指向 `bin.cjs` 的符号链接，`realpathSync` 之后可以直接用 node 执行，
 * 不需要依赖 PATH 或 shell。
 */
const resolveDrizzleKit = (): string => {
  let directory = packageDirectory;

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
        schemaDirectory,
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

const listMigrations = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory);

  return entries.filter((name) => name.endsWith(".sql")).toSorted();
};

const committed = await listMigrations(migrationsDirectory);
const workDirectory = await mkdtemp(path.join(tmpdir(), "aify-db-check-"));

try {
  const scratch = path.join(workDirectory, "migrations");

  await cp(migrationsDirectory, scratch, { recursive: true });
  await runGenerate(workDirectory);

  const generated = await listMigrations(scratch);
  const pending = generated.filter((name) => !committed.includes(name));

  if (pending.length > 0) {
    console.error(
      `[db] schema has changes without a migration: ${pending.join(", ")}`
    );
    console.error(
      "[db] run `vp run db#db:generate`, review the SQL, and commit it."
    );
    process.exitCode = 1;
  } else {
    console.log(
      `[db] migrations match the schema (${committed.length} migration(s))`
    );
  }
} finally {
  await rm(workDirectory, { force: true, recursive: true });
}
