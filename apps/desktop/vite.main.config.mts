// oxlint-disable unicorn/prefer-module
import path from "node:path";

import { defineConfig } from "vite";

// https://vitejs.dev/config
export default defineConfig(({ command }) => ({
  // Forge 的 plugin-vite 默认不生成 sourcemap，主进程 bundle（.vite/build/main.js）
  // 里就找不到 packages/server、packages/agent 等源码的位置，断点会变成 unbound。
  // 这个 configEnv 由 Forge 注入：start 时是 'serve'，package/make 时是 'build'，
  // 所以只在 dev 打开，生产保持关闭，避免源码被内联进包。
  // 用 inline 而不是 true，避免 .map 相对路径解析问题。
  build: {
    sourcemap: command === "serve" ? "inline" : false,
  },
  optimizeDeps: {
    exclude: [
      "@workspace/ui",
      "@workspace/shared",
      "@workspace/server",
      "@workspace/agent",
      "@workspace/agent-client",
    ],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@workspace/shared": path.resolve(__dirname, "../../packages/shared/src"),
      "@workspace/agent": path.resolve(__dirname, "../../packages/agent/src"),
      "@workspace/agent-client": path.resolve(
        __dirname,
        "../../packages/agent-client/src"
      ),
    },
  },
}));
