import { defineConfig } from "vite";

// Vite only emits JS. The `build` script runs
// `scripts/stage-server-dist.ts` afterwards to add the files a bundle cannot
// carry: the `@libsql` native binding, the ripgrep binary, and an ESM
// `package.json`.
export default defineConfig({
  // `noExternal: true` inlines third-party JS too; only Node builtins and the
  // native binding staged after the build stay external at runtime.
  ssr: { noExternal: true },
  build: {
    emptyOutDir: true,
    outDir: "dist",
    // Node 22 is the floor declared by the workspace `engines` field.
    target: "node22",
    ssr: "src/index.ts",
    rollupOptions: {
      output: { entryFileNames: "index.js" },
    },
  },
});
