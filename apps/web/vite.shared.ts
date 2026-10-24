// oxlint-disable unicorn/prefer-module
import path from "node:path";

import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import type { ProxyOptions, UserConfig } from "vite";

// 配置文件由 Vite 用 esbuild 打包，这里直接相对引用同一份端口常量，免得为
// 两个端口再抄一遍字面量，或把 node 端的包拖进配置的解析链路。
import { resolveApiEndpoint } from "../../packages/shared/src/api-endpoint";
import { resolveApiToken } from "../../packages/shared/src/api-token";
import { DEFAULT_WEB_PORT } from "../../packages/shared/src/constants";

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

/**
 * API 现在要求 bearer token，而浏览器不应该持有它。Vite 代理在服务端注入，
 * 和 Electron 主进程的转发保持同一条规则。
 */
const createApiProxy = (target: string): Record<string, ProxyOptions> => {
  const entry = (): ProxyOptions => ({
    target,
    configure: (proxy) => {
      proxy.on("proxyReq", (request) => {
        request.setHeader("authorization", `Bearer ${resolveApiToken()}`);
      });
    },
  });

  return {
    "/api": entry(),
  };
};

export interface WebViteOptions {
  readonly desktop?: boolean;
}

export const createWebViteConfig = ({
  desktop = false,
}: WebViteOptions = {}): UserConfig => {
  // `owned` 模式下 server 会忽略 AIFY_API_ORIGIN，代理也必须看同一个 origin，
  // 否则 Vite 会把请求转到一个桌面端根本没用的地址。
  const configuredApiOrigin =
    process.env.AIFY_SERVER_MODE === "owned"
      ? undefined
      : process.env.AIFY_API_ORIGIN?.trim();
  const apiEndpoint =
    configuredApiOrigin === undefined || configuredApiOrigin === ""
      ? resolveApiEndpoint()
      : undefined;
  const apiTarget =
    configuredApiOrigin === undefined || configuredApiOrigin === ""
      ? apiEndpoint?.origin
      : configuredApiOrigin;

  // 桌面默认走 aify-app://，/api 由主进程转发，Vite 代理用不上；只有
  // `AIFY_APP_PROTOCOL=0` 或独立浏览器构建才需要它。
  const needsApiProxy = !desktop || process.env.AIFY_APP_PROTOCOL === "0";

  if (apiTarget === undefined && needsApiProxy) {
    throw new Error(
      "The web dev server cannot proxy AIFY_API_PORT=0: set AIFY_API_ORIGIN or a fixed AIFY_API_PORT"
    );
  }

  const apiProxy =
    apiTarget === undefined ? undefined : createApiProxy(apiTarget);

  return {
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
      // 桌面窗口启动时第一件事就是拉 index + 入口模块；提前预热，避免
      // Electron 先到、Vite 才开始 transform 的首屏空白。
      warmup: {
        clientFiles: [
          path.resolve(webRoot, "src/main.tsx"),
          path.resolve(workspaceRoot, "packages/ui/src/app.tsx"),
          path.resolve(workspaceRoot, "packages/ui/src/routes/**/*.tsx"),
        ],
      },
    },
    preview: {
      host: "127.0.0.1",
      proxy: apiProxy,
    },
  };
};
