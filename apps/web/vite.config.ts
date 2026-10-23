import { defineConfig } from "vite";

import { createWebViteConfig } from "./vite.shared";

// 独立浏览器构建：`vite dev` / `vite build` 都走这一份。
export default defineConfig(createWebViteConfig());
