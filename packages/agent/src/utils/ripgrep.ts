import { spawn } from "node:child_process";

const RG_BINARY = process.platform === "win32" ? "rg.exe" : "rg";

/**
 * Module-level cache: probes once per process lifetime whether `rg` is on PATH.
 * Lazily initialized — no work is done at import time. The first call to
 * {@link getRipgrepAvailable} triggers the probe; subsequent calls return the
 * cached promise, so only one `rg --version` is ever spawned.
 */
let ripgrepAvailable: Promise<boolean> | null = null;

function probeRipgrep(): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    // `command -v rg` would not work here: `command` is a shell builtin and
    // only macOS ships a standalone `/usr/bin/command` for it.
    const proc = spawn(RG_BINARY, ["--version"], {
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
 * Returns a cached promise that resolves to `true` when `rg` is on PATH.
 * The probe runs at most once per process lifetime — the first call triggers
 * the check, every subsequent call reuses the cached result.
 */
export function getRipgrepAvailable(): Promise<boolean> {
  if (ripgrepAvailable === null) {
    ripgrepAvailable = probeRipgrep();
  }
  return ripgrepAvailable;
}
