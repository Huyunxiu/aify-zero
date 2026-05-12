import path from "path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import { defineConfig } from "vite";

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    tanstackRouter({
      routesDirectory: "./src/renderer/routes",
      generatedRouteTree: "./src/renderer/routeTree.gen.ts",
      quoteStyle: "double",
      target: "react",
      autoCodeSplitting: true,
    }),
    react() as any,
    tailwindcss(),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
