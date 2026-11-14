import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";
import { defineConfig } from "drizzle-kit";

// 与运行期入口保持一致的查找顺序：`apps/server/.env` → 仓库根 `.env` →
// 旧的 `packages/server/.env`（仅作兼容）。用绝对路径，避免 drizzle-kit
// 从不同目录启动时读到不同的库。
// Drizzle Kit's config loader may not expose import.meta.dirname.
// oxlint-disable-next-line unicorn/prefer-import-meta-properties
const here = import.meta.dirname ?? dirname(fileURLToPath(import.meta.url));

dotenv.config({
  path: [
    resolve(here, "../../apps/server/.env"),
    resolve(here, "../../.env"),
    resolve(here, "../server/.env"),
  ],
  quiet: true,
});

// 这些命令服务的是开发流程，所以默认库是 checkout 根部的 `local.db`——和
// `apps/server` 用的同一个文件。运行期的默认值（`~/.aify-zero`）属于用户库，
// 不能拿来做 CLI 的默认值：仓库里没有 `.env`，留空会让 drizzle-kit 以「缺少
// url」退出。要操作别的库就设 `DATABASE_URL`。
const configuredUrl = process.env.DATABASE_URL;

export default defineConfig({
  dbCredentials: {
    url:
      configuredUrl === undefined || configuredUrl === ""
        ? `file:${resolve(here, "../../local.db")}`
        : configuredUrl,
  },
  dialect: "turso",
  out: "./src/migrations",
  schema: "./src/schema",
});
