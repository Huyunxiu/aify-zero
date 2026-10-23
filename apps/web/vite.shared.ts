// oxlint-disable unicorn/prefer-module
import path from "node:path";

import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import type { UserConfig } from "vite";

// 配置文件由 Vite 用 esbuild 打包，这里直接相对引用同一份端口常量，免得为
// 两个端口再抄一遍字面量，或把 node 端的包拖进配置的解析链路。
import {
  DEFAULT_API_PORT,
  DEFAULT_WEB_PORT,
} from "../../packages/shared/src/constants";

/**
 * apps/web 的 Vite 配置只有一份：独立浏览器构建和桌面壳的 renderer 构建
 * 都从这里取插件与别名，避免两套配置漂移。
 *
 * `desktop` 只影响编译期常量 `__AIFY_DESKTOP__`：桌面构建保留 preload
 * IPC 的引导，浏览器构建把它摇掉。
 */
const webRoot = __dirname;
const workspaceRoot = path.resolve(webRoot, "../..");

/** 开发服务器端口：独立 web 和桌面反代共用同一个值。 */
const devPort = Number(process.env.AIFY_WEB_PORT ?? DEFAULT_WEB_PORT);

/** 浏览器里单独运行时，`/rpc` 和 OpenAPI 由同源代理转到 API 进程。 */
const apiTarget =
  process.env.AIFY_API_ORIGIN ?? `http://127.0.0.1:${DEFAULT_API_PORT}`;
const apiProxy = {
  "/api-reference": { target: apiTarget },
  "/rpc": { target: apiTarget },
};

export interface WebViteOptions {
  readonly desktop?: boolean;
}

export const createWebViteConfig = ({
  desktop = false,
}: WebViteOptions = {}): UserConfig => ({
  // 文档永远挂在源根目录：浏览器是站点根，桌面是 aify-app://app/。
  base: "/",
  define: {
    __AIFY_DESKTOP__: JSON.stringify(desktop),
  },
  optimizeDeps: {
    exclude: [
      "@workspace/agent",
      "@workspace/agent-client",
      "@workspace/server",
      "@workspace/shared",
      "@workspace/ui",
    ],
  },
  plugins: [
    tanstackRouter({
      autoCodeSplitting: false,
      generatedRouteTree: path.resolve(
        workspaceRoot,
        "packages/ui/src/routeTree.gen.ts"
      ),
      quoteStyle: "double",
      routesDirectory: path.resolve(workspaceRoot, "packages/ui/src/routes"),
      target: "react",
    }),
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      "@": path.resolve(webRoot, "src"),
      "@desktop": path.resolve(workspaceRoot, "apps/desktop/src"),
      "@workspace/agent": path.resolve(workspaceRoot, "packages/agent/src"),
      "@workspace/agent-client": path.resolve(
        workspaceRoot,
        "packages/agent-client/src"
      ),
      "@workspace/server": path.resolve(workspaceRoot, "packages/server/src"),
      "@workspace/shared": path.resolve(workspaceRoot, "packages/shared/src"),
      "@workspace/ui": path.resolve(workspaceRoot, "packages/ui/src"),
    },
    dedupe: ["react", "react-dom"],
  },
  server: {
    host: "127.0.0.1",
    port: devPort,
    strictPort: true,
    // 桌面窗口的文档源是 aify-app://，Vite 客户端无法从 location 推出
    // WebSocket 地址（import.meta.url 没有端口），必须显式给出 host 和
    // port；port 与 HTTP 端口一致时 HMR 复用同一个 server。
    hmr: { host: "127.0.0.1", port: devPort, protocol: "ws" },
    proxy: apiProxy,
  },
  preview: {
    host: "127.0.0.1",
    proxy: apiProxy,
  },
});
