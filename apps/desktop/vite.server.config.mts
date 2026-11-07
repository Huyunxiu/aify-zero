// oxlint-disable unicorn/prefer-module
import { defineConfig } from "vite";

// Forge 的第二个 `main` 目标：产物是 `.vite/build/server-entry.js`，由主进程
// 的 `utilityProcess.fork` 执行。Forge 会合并自己的 main 配置（electron /
// node builtins 外置、CJS 输出），这里补上原生 PTY 模块的外置：`.node` 文件
// 不能内联，打包时由 forge.config.ts 单独复制并解包。
export default defineConfig(({ command }) => ({
  build: {
    rollupOptions: {
      external: ["@lydell/node-pty"],
    },
    sourcemap: command === "serve" ? "inline" : false,
  },
}));
