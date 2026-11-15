// oxlint-disable unicorn/prefer-module
import { defineConfig } from "vite";

// Forge 的第二个 `main` 目标：产物是 `.vite/build/server-entry.cjs`，由主进程
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
  // 产物是 CJS，`import.meta` 在 CJS 里不存在，打包器会把它换成 `{}`：
  // `import.meta.dirname` 于是变成 undefined，`packages/db` 解析迁移目录时
  // 会在启动阶段抛 ERR_INVALID_ARG_TYPE。CJS 里有 `__dirname`，直接定义过去。
  define: {
    "import.meta.dirname": "__dirname",
  },
}));
