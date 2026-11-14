/**
 * 独立 API server 进程。
 *
 * `vp run dev:server` / `vp run dev:api` 从这里启动；Electron 打包后不复用
 * 这个入口，而是用 Forge 构建的 `server-entry.js`，两者最终都调用
 * `@workspace/server/serve` 的 `runServerProcess()`。
 *
 * 环境变量在这个入口加载：库模块不再按 cwd 找 `.env`，否则同一份代码在
 * 仓库根、`apps/server` 和打包资源目录下会连到不同的数据库。
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { resolveDevelopmentDatabaseUrl } from "@workspace/db/paths";
import { RIPGREP_PATH_ENV } from "@workspace/shared/constants";
import dotenv from "dotenv";

const sourceDirectory = import.meta.dirname;
// src/ 和打包后的 dist/ 都位于 apps/server 下，向上一级就是应用目录。
const appDirectory = resolve(sourceDirectory, "..");
const workspaceRoot = resolve(appDirectory, "../..");

// 先确定环境，再动态 import：`@workspace/db` 在模块求值时就创建连接。
dotenv.config({
  path: [resolve(appDirectory, ".env"), resolve(workspaceRoot, ".env")],
  quiet: true,
});

// 打包产物把 rg 放在与 `dist/index.js` 同级的 `dist/bin/` 里。显式告诉
// agent 的 grep/glob 工具用这一份，避免打包后依赖目标机器的 PATH。开发期
// (`src/index.ts`) 没有这个文件，保持原来的 PATH 探测。
const bundledRipgrep = resolve(
  sourceDirectory,
  "bin",
  process.platform === "win32" ? "rg.exe" : "rg"
);

if (
  existsSync(bundledRipgrep) &&
  (process.env[RIPGREP_PATH_ENV] === undefined ||
    process.env[RIPGREP_PATH_ENV] === "")
) {
  process.env[RIPGREP_PATH_ENV] = bundledRipgrep;
}

// 开发库钉在当前 checkout 根部：worktree 不会带上被 gitignore 的 `local.db`，
// 一旦回落到 `~/.aify-zero`，几个 worktree 会共享同一个库并互相打断迁移。
// 文件不存在时 libsql 首次连接就会创建它，随后的启动迁移负责建表。
process.env.DATABASE_URL = resolveDevelopmentDatabaseUrl(workspaceRoot);

const { runServerProcess } = await import("@workspace/server/serve");

await runServerProcess();
