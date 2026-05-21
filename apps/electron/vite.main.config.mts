// oxlint-disable unicorn/prefer-module
import path from "node:path";

import { defineConfig } from "vite";

// https://vitejs.dev/config
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@workspace/ui": path.resolve(__dirname, "../../packages/ui/src/*"),
    },
  },
});
