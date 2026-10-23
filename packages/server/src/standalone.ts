/**
 * 独立 API 进程：`apps/web` 在浏览器里单独开发 / 预览时，Vite 的
 * `/rpc` 代理指向这个进程。桌面端不用它——桌面走同进程 `server.fetch`。
 */
import { serve } from "@hono/node-server";
import { DEFAULT_API_PORT } from "@workspace/shared/constants";

import { app } from "./app";

const hostname = process.env.AIFY_API_HOST ?? "127.0.0.1";
const port = Number(process.env.AIFY_API_PORT ?? DEFAULT_API_PORT);

if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
  throw new Error(`Invalid AIFY_API_PORT: ${process.env.AIFY_API_PORT}`);
}

serve({ fetch: app.fetch, hostname, port }, (info) => {
  console.log(`API listening on http://${hostname}:${info.port}`);
});
