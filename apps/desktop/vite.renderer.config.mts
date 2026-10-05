// oxlint-disable unicorn/prefer-module
import path from "node:path";

import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// https://vite.dev/config/
export default defineConfig({
  optimizeDeps: {
    exclude: ["@workspace/ui", "@workspace/shared", "@workspace/server", "@workspace/agent-client"],
  },
  plugins: [
    tanstackRouter({
      autoCodeSplitting: false,
      generatedRouteTree: "../../packages/ui/src/routeTree.gen.ts",
      quoteStyle: "double",
      routesDirectory: "../../packages/ui/src/routes",
      target: "react",
    }),
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@workspace/ui": path.resolve(__dirname, "../../packages/ui/src"),
      "@workspace/shared": path.resolve(__dirname, "../../packages/shared/src"),
      "@workspace/agent-client": path.resolve(__dirname, "../../packages/agent-client/src"),
    },
  },
});
