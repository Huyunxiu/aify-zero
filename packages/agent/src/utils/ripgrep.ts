import { spawn } from "node:child_process";

/**
 * Module-level cache: probes once per process lifetime whether `rg` is on PATH.
 * Lazily initialized — no work is done at import time. The first call to
 * {@link getRgAvailable} triggers the probe; subsequent calls return the cached
 * promise, so only one `command -v rg` is ever spawned.
 */
let ripgrepAvailable: Promise<boolean> | null = null;

function probeRipgrep(): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const proc = spawn("command", ["-v", "rg"], {
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
