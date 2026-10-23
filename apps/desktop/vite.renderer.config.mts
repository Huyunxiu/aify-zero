// oxlint-disable unicorn/prefer-module
import path from "node:path";

import { defineConfig } from "vite";

import { createWebViteConfig } from "../web/vite.shared";

const desktopRoot = __dirname;

// 桌面壳的 renderer 直接构建 apps/web，产物落在 Forge 约定的
// `.vite/renderer/main_window`，打包后由 aify-app:// 协议 handler 读取。
export default defineConfig({
  ...createWebViteConfig({ desktop: true }),
  root: path.resolve(desktopRoot, "../web"),
  build: {
    emptyOutDir: true,
    // 相对 outDir 会以 root（apps/web）为基准，这里必须用绝对路径。
    outDir: path.resolve(desktopRoot, ".vite/renderer/main_window"),
  },
});
