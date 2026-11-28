import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { RIPGREP_PATH_ENV } from "@workspace/shared/constants";

const RG_BINARY = process.platform === "win32" ? "rg.exe" : "rg";
const VSCODE_RIPGREP_PACKAGE = "@vscode/ripgrep";

/**
 * Resolved executable, cached for the process lifetime.
 *
 * `undefined` means "not resolved yet"; once resolved it is either the absolute
 * path of a staged binary or the bare `rg` name (looked up on `PATH`).
 */
let ripgrepPath: string | undefined;

/**
 * Paths a packaging flow may stage the binary at, in priority order.
 *
 * The env override wins because both packaging flows set it explicitly. The
 * remaining locations are fallbacks for processes that never got the variable
 * — for example a server started outside its package launcher:
 *
 *   - Electron exposes `process.resourcesPath`; the desktop stages the binary
 *     at `<resources>/resources/bin/rg` (the `resources/` directory is
 *     `extraResource`) and also accepts a flat `<resources>/bin/rg`.
 *   - Node puts the entry script next to its resources: `apps/server` stages
 *     `dist/bin/rg` beside `dist/index.js`, so `argv[1]`'s directory works.
 */
function candidatePaths(): string[] {
  const candidates: string[] = [];
  const configured = process.env[RIPGREP_PATH_ENV]?.trim();

  if (configured !== undefined && configured !== "") {
    candidates.push(configured);
  }

  const { resourcesPath } = process as NodeJS.Process & {
    resourcesPath?: string;
  };

  if (typeof resourcesPath === "string" && resourcesPath !== "") {
    candidates.push(path.join(resourcesPath, "resources", "bin", RG_BINARY));
    candidates.push(path.join(resourcesPath, "bin", RG_BINARY));
  }

  const [, entry] = process.argv;

  if (entry !== undefined && entry !== "") {
    candidates.push(path.join(path.dirname(entry), "bin", RG_BINARY));
  }

  return candidates;
}

export interface ResolveRipgrepOptions {
  /** Override package binary lookup; tests pass a stub to verify PATH fallback. */
  readonly resolvePackageBinary?: () => string | undefined;
}

/**
 * Resolves the ripgrep binary shipped by the installed `@vscode/ripgrep`
 * package for local development and tests where no staged `bin/rg` exists.
 *
 * Resolved lazily through `createRequire` instead of a static import so
 * bundled server builds (which stage `bin/rg` separately and omit
 * `@vscode/ripgrep` from their `node_modules`) never fail at module load.
 */
function resolvePackageRipgrep(): string | undefined {
  const platformPackage = `@vscode/ripgrep-${process.platform}-${process.arch}`;
  const binarySpecifier = `${platformPackage}/bin/${RG_BINARY}`;

  try {
    const requireFromModule = createRequire(import.meta.url);
    const packageEntry = requireFromModule.resolve(VSCODE_RIPGREP_PACKAGE);
    const resolved = createRequire(packageEntry).resolve(binarySpecifier);

    // Packaged Electron builds cannot execute binaries inside an `.asar` archive.
    if (resolved.split(path.sep).some((segment) => segment.endsWith(".asar"))) {
      return undefined;
    }

    return resolved;
  } catch {
    return undefined;
  }
}

/**
 * Resolves the ripgrep executable using the priority order:
 * `AIFY_RIPGREP_PATH` -> staged binary -> `@vscode/ripgrep` package binary -> `rg` on `PATH`.
 */
export function resolveRipgrepPath(
  options: ResolveRipgrepOptions = {}
): string {
  for (const candidate of candidatePaths()) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  const packageBinary = (
    options.resolvePackageBinary ?? resolvePackageRipgrep
  )();
  if (packageBinary !== undefined && existsSync(packageBinary)) {
    return packageBinary;
  }

  return RG_BINARY;
}

/**
 * Returns the ripgrep executable the tools should invoke.
 *
 * Resolution order: `AIFY_RIPGREP_PATH` -> staged binary -> installed
 * `@vscode/ripgrep` package binary -> `rg` on `PATH`.
 *
 * @returns An absolute path to a staged or package binary, or `rg` / `rg.exe`.
 */
export function getRipgrepPath(): string {
  if (ripgrepPath !== undefined) {
    return ripgrepPath;
  }

  ripgrepPath = resolveRipgrepPath();
  return ripgrepPath;
}

/**
 * Module-level cache: probes once per process lifetime whether the resolved
 * ripgrep binary can run. Lazily initialized — no work is done at import time.
 * The first call triggers the probe; subsequent calls return the cached
 * promise, so only one `rg --version` is ever spawned.
 */
let ripgrepAvailable: Promise<boolean> | null = null;

function probeRipgrep(): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const proc = spawn(getRipgrepPath(), ["--version"], {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });

    let settled = false;

    proc.on("error", () => {
      if (!settled) {
        settled = true;
        resolve(false);
      }
    });

    proc.on("exit", (code) => {
      if (!settled) {
        settled = true;
        resolve(code === 0);
      }
    });

    // Timeout the probe after 2 seconds to avoid hanging on a broken binary.
    setTimeout(() => {
      if (!settled) {
        settled = true;
        proc.kill();
        resolve(false);
      }
    }, 2000);
  });
}

/**
 * Returns a cached promise that resolves to `true` when the resolved `rg`
 * binary is runnable. The probe runs at most once per process lifetime.
 */
export function getRipgrepAvailable(): Promise<boolean> {
  if (ripgrepAvailable === null) {
    ripgrepAvailable = probeRipgrep();
  }

  return ripgrepAvailable;
}
