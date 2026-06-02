// oxlint-disable unicorn/prefer-module
import path from "node:path";

import { defineConfig } from "vite";

// https://vitejs.dev/config
export default defineConfig({
  optimizeDeps: {
    exclude: ["@workspace/ui", "@workspace/shared", "@workspace/server"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
