import { resolve } from "node:path";

import dotenv from "dotenv";
import { defineConfig } from "drizzle-kit";

// 与运行期入口保持一致的查找顺序：`apps/server/.env` → 仓库根 `.env` →
// 旧的 `packages/server/.env`（仅作兼容）。用绝对路径，避免 drizzle-kit
// 从不同目录启动时读到不同的库。
const here = import.meta.dirname;

dotenv.config({
  path: [
    resolve(here, "../../apps/server/.env"),
    resolve(here, "../../.env"),
    resolve(here, "../server/.env"),
  ],
  quiet: true,
});

export default defineConfig({
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "",
  },
  dialect: "turso",
  out: "./src/migrations",
  schema: "./src/schema",
});
