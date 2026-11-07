import { existsSync } from "node:fs";
import { chmod, cp, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { stageRipgrep } from "./stage-ripgrep";

// `vp build` only emits JS. This post-build step adds the files a bundle
// cannot carry, so the output directory is deployable on its own:
//
//   - `node_modules/@libsql/` — the native binding the bundled client loads at
//     runtime, which cannot be inlined into JS;
//   - `node_modules/@lydell/` — the PTY native binding and its platform package;
//     `spawn-helper` must stay an executable file outside the bundle;
//   - `bin/rg` — the ripgrep binary the agent's grep/glob tools execute, which
//     cannot be executed from inside a bundle;
//   - `package.json` — marks the output as ESM even outside this repository.
//
// Invoked as `tsx ../../scripts/stage-server-dist.ts dist` from `apps/server`.
const workspaceRoot = path.resolve(import.meta.dirname, "..");
const outputDirectory = path.resolve(process.argv[2] ?? "dist");
const libsqlSource = path.join(workspaceRoot, "node_modules", "@libsql");
const ptySource = path.join(workspaceRoot, "node_modules", "@lydell");

if (!existsSync(libsqlSource)) {
  throw new Error(
    `@libsql packages missing at ${libsqlSource}; run \`vp install\` first.`
  );
}

if (!existsSync(ptySource)) {
  throw new Error(
    `@lydell packages missing at ${ptySource}; run \`vp install\` first.`
  );
}

await mkdir(outputDirectory, { recursive: true });

await cp(libsqlSource, path.join(outputDirectory, "node_modules", "@libsql"), {
  recursive: true,
  preserveTimestamps: true,
});

const ptyDestination = path.join(outputDirectory, "node_modules", "@lydell");
await cp(ptySource, ptyDestination, {
  recursive: true,
  preserveTimestamps: true,
});

// npm preserves this bit, but a copied tree does not guarantee it on every
// platform. The native module execs this helper directly.
const spawnHelper = path.join(
  ptyDestination,
  `node-pty-${process.platform}-${process.arch}`,
  "prebuilds",
  `${process.platform}-${process.arch}`,
  "spawn-helper"
);
if (existsSync(spawnHelper)) {
  await chmod(spawnHelper, 0o755);
}

await stageRipgrep(path.join(outputDirectory, "bin"));

// Without this, Node treats the copied `dist/*.js` files as CommonJS.
await writeFile(
  path.join(outputDirectory, "package.json"),
  `${JSON.stringify({ type: "module", private: true }, null, 2)}\n`
);
