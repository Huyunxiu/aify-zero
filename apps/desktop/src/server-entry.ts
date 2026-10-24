/**
 * 内置 API server 的 Electron 入口。
 *
 * Forge 把它当作第二个 `main` 目标构建到 `.vite/build/server-entry.js`，
 * 主进程用 `utilityProcess.fork` 启动它。进程环境由主进程显式传入
 * （`DATABASE_URL` / `AIFY_MIGRATIONS_DIR` / PATH），所以这里不读 `.env`。
 */
import { runServerProcess } from "@workspace/server/serve";

runServerProcess().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
