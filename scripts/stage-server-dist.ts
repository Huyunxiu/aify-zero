import { existsSync } from "node:fs";
import { cp, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { stageRipgrep } from "./stage-ripgrep";

// `vp build` only emits JS. This post-build step adds the files a bundle
// cannot carry, so the output directory is deployable on its own:
//
//   - `node_modules/@libsql/` — the native binding the bundled client loads at
//     runtime, which cannot be inlined into JS;
//   - `bin/rg` — the ripgrep binary the agent's grep/glob tools execute, which
//     cannot be executed from inside a bundle;
//   - `package.json` — marks the output as ESM even outside this repository.
//
// Invoked as `tsx ../../scripts/stage-server-dist.ts dist` from `apps/server`.
const workspaceRoot = path.resolve(import.meta.dirname, "..");
const outputDirectory = path.resolve(process.argv[2] ?? "dist");
const libsqlSource = path.join(workspaceRoot, "node_modules", "@libsql");

if (!existsSync(libsqlSource)) {
  throw new Error(
    `@libsql packages missing at ${libsqlSource}; run \`vp install\` first.`
  );
}

await mkdir(outputDirectory, { recursive: true });

await cp(libsqlSource, path.join(outputDirectory, "node_modules", "@libsql"), {
  recursive: true,
  preserveTimestamps: true,
});

await stageRipgrep(path.join(outputDirectory, "bin"));

// Without this, Node treats the copied `dist/*.js` files as CommonJS.
await writeFile(
  path.join(outputDirectory, "package.json"),
  `${JSON.stringify({ type: "module", private: true }, null, 2)}\n`
);
