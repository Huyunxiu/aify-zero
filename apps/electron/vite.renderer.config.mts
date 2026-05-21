// oxlint-disable unicorn/prefer-module
import path from "node:path";

import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    tanstackRouter({
      autoCodeSplitting: false,
      generatedRouteTree: "./src/routeTree.gen.ts",
      quoteStyle: "double",
      routesDirectory: "./src/routes",
      target: "react",
    }),
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@workspace/shared": path.resolve(__dirname, "../../packages/shared/src"),
    },
  },
});
