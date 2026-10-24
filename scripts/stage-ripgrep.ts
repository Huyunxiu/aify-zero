import { existsSync } from "node:fs";
import { chmod, cp, mkdir } from "node:fs/promises";
import path from "node:path";

import { rgPath } from "@vscode/ripgrep";

/** Binary name `@vscode/ripgrep` ships for this platform. */
const ripgrepBinaryName = process.platform === "win32" ? "rg.exe" : "rg";

/**
 * Copies the ripgrep binary bundled by `@vscode/ripgrep` into `directory`.
 *
 * The binary can neither be inlined into a JS bundle nor executed from inside
 * an asar archive, so every packaging flow has to stage it as a real file next
 * to the application it ships with:
 *
 *   - `apps/desktop`: `resources/bin/rg`, carried by `extraResource`;
 *   - `apps/server`: `dist/bin/rg`, next to the built `dist/index.js`.
 *
 * The executable bit is re-applied on copy because a lost bit only surfaces
 * much later, as an `EACCES` on the first search.
 *
 * @param directory - Directory to place the binary in; created when missing.
 * @returns Absolute path of the staged binary.
 */
export async function stageRipgrep(directory: string): Promise<string> {
  if (!existsSync(rgPath)) {
    throw new Error(
      `ripgrep binary missing at ${rgPath}. "@vscode/ripgrep" ships it in the ` +
        `@vscode/ripgrep-${process.platform}-${process.arch} optional package.`
    );
  }

  const destination = path.join(directory, ripgrepBinaryName);

  await mkdir(directory, { recursive: true });
  await cp(rgPath, destination);

  if (process.platform !== "win32") {
    await chmod(destination, 0o755);
  }

  return destination;
}
