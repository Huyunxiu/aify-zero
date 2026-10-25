import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";

/** Default SIGTERM → SIGKILL grace period. */
export const DEFAULT_GRACE_MS = 2000;

/**
 * How long the collector keeps reading after the shell exits. A grandchild may
 * still hold the pipe and write; every chunk re-arms this timer, while a quiet
 * inherited handle releases the call after one idle period.
 */
export const DEFAULT_DRAIN_IDLE_MS = 100;

export interface ShellRunOptions {
  /** Resolved executable, never a shell metacharacter path. */
  file: string;
  args: string[];
  cwd: string;
  /** The complete environment; the caller owns overrides and scrubbing. */
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal?: AbortSignal;
  onData: (channel: "stdout" | "stderr", chunk: Buffer) => void;
  /** Called once the child exists. Test seam for asserting termination. */
  onSpawn?: (pid: number) => void;
  graceMs?: number;
  drainIdleMs?: number;
}

export interface ShellRunResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  aborted: boolean;
  durationMs: number;
}

type EndReason = "timeout" | "abort";

/**
 * Run one shell command under a deadline and an optional caller signal.
 *
 * Resolution happens on the process's `exit` plus a drain window, not `close`
 * alone: a shell that exits while a descendant keeps stdout open would
 * otherwise either hang the call or drop the descendant's output. The deadline
 * stays armed until the call settles, so a chatty descendant cannot extend it.
 */
export function runShell(options: ShellRunOptions): Promise<ShellRunResult> {
  const startedAt = performance.now();
  if (options.signal?.aborted === true) {
    return Promise.resolve({
      exitCode: null,
      signal: null,
      timedOut: false,
      aborted: true,
      durationMs: Math.round(performance.now() - startedAt),
    });
  }

  const child = spawn(options.file, options.args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
    windowsHide: true,
  });
  const { pid } = child;
  if (pid !== undefined) {
    options.onSpawn?.(pid);
  }

  const drainIdleMs = options.drainIdleMs ?? DEFAULT_DRAIN_IDLE_MS;
  const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;

  let endReason: EndReason | undefined;
  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;
  let killTimer: NodeJS.Timeout | undefined;

  return new Promise<ShellRunResult>((resolve, reject) => {
    let exited = false;
    let settled = false;
    let drainTimer: NodeJS.Timeout | undefined;

    // Armed before the handlers are attached so the deadline covers the whole
    // call; it stays armed until the call settles, drain included.
    const timeoutTimer = setTimeout(
      () => trigger("timeout"),
      Math.max(1, options.timeoutMs)
    );

    const cleanup = () => {
      if (timeoutTimer !== undefined) {
        clearTimeout(timeoutTimer);
      }
      if (drainTimer !== undefined) {
        clearTimeout(drainTimer);
      }
      if (killTimer !== undefined) {
        clearTimeout(killTimer);
      }
      options.signal?.removeEventListener("abort", onAbort);
      child.stdout?.destroy();
      child.stderr?.destroy();
    };

    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve({
        exitCode,
        signal: exitSignal,
        timedOut: endReason === "timeout",
        aborted: endReason === "abort",
        durationMs: Math.round(performance.now() - startedAt),
      });
    };

    /**
     * Resolve once the process has exited and the output pipes have gone idle.
     * Called by every data/close event; the timer only arms after `exit`.
     */
    const armDrain = () => {
      if (!exited || settled) {
        return;
      }
      if (drainTimer !== undefined) {
        clearTimeout(drainTimer);
      }
      drainTimer = setTimeout(finish, drainIdleMs);
    };

    const terminate = () => {
      if (pid === undefined) {
        child.kill();
        return;
      }
      if (process.platform === "win32") {
        taskkillTree(pid);
        return;
      }
      signalTree(pid, "SIGTERM");
      killTimer ??= setTimeout(() => signalTree(pid, "SIGKILL"), graceMs);
    };

    const trigger = (reason: EndReason) => {
      if (endReason !== undefined) {
        return;
      }
      endReason = reason;
      terminate();
    };

    const onAbort = () => {
      trigger("abort");
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      options.onData("stdout", chunk);
      armDrain();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      options.onData("stderr", chunk);
      armDrain();
    });
    child.stdout?.once("close", armDrain);
    child.stderr?.once("close", armDrain);

    child.once("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    });

    child.once("exit", (code, signal) => {
      exited = true;
      exitCode = code;
      exitSignal = signal;
      armDrain();
    });

    if (options.signal !== undefined) {
      options.signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

/** Signal the POSIX process group, falling back to the direct child. */
function signalTree(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // The tree is already gone; both deliveries raced the same exit.
    }
  }
}

/**
 * Terminate a Windows process tree. `taskkill` is addressed through the system
 * directory so cleanup does not depend on PATH, and failure is contained: the
 * direct child is still killed if the utility cannot start.
 */
function taskkillTree(pid: number): void {
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  const result = spawnSync(
    join(systemRoot, "System32", "taskkill.exe"),
    ["/PID", String(pid), "/T", "/F"],
    { stdio: "ignore", windowsHide: true }
  );
  if (result.error !== undefined) {
    try {
      process.kill(pid);
    } catch {
      // Already exited.
    }
  }
}
