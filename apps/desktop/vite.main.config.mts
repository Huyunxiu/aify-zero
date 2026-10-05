// oxlint-disable unicorn/prefer-module
import path from "node:path";

import { defineConfig } from "vite";

// https://vitejs.dev/config
export default defineConfig({
  optimizeDeps: {
    exclude: [
      "@workspace/ui",
      "@workspace/shared",
      "@workspace/server",
      "@workspace/server",
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
});
