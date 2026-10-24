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

if (process.env.DATABASE_URL === undefined || process.env.DATABASE_URL === "") {
  const localDatabase = resolve(workspaceRoot, "local.db");

  if (existsSync(localDatabase)) {
    process.env.DATABASE_URL = `file:${localDatabase}`;
  }
}

const { runServerProcess } = await import("@workspace/server/serve");

await runServerProcess();
