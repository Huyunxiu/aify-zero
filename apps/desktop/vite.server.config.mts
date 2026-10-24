// oxlint-disable unicorn/prefer-module
import { defineConfig } from "vite";

// Forge 的第二个 `main` 目标：产物是 `.vite/build/server-entry.js`，由主进程
// 的 `utilityProcess.fork` 执行。Forge 会合并自己的 main 配置（electron /
// node builtins 外置、CJS 输出），这里只保留调试用的 sourcemap 策略。
export default defineConfig(({ command }) => ({
  build: {
    sourcemap: command === "serve" ? "inline" : false,
  },
}));
