import { describe, expect, test, vi } from "vitest";

import type { ShellRunOptions } from "../../../src/tools/shell/exec.js";
import { runShell } from "../../../src/tools/shell/exec.js";
import {
  bashArgv,
  resolveBashShell,
} from "../../../src/tools/shell/resolve.js";

const IS_WINDOWS = process.platform === "win32";
const shellFile = resolveBashShell() ?? "/bin/bash";

const sleep = (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

function run(
  command: string,
  options: Partial<ShellRunOptions> = {}
): Promise<{
  result: Awaited<ReturnType<typeof runShell>>;
  stdout: string;
  stderr: string;
}> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const argv = bashArgv(shellFile, command);
  return runShell({
    file: argv[0]!,
    args: argv.slice(1),
    cwd: process.cwd(),
    env: { ...process.env, NO_COLOR: "1", TERM: "dumb" },
    timeoutMs: 5000,
    ...options,
    onData: (channel, chunk) => {
      if (channel === "stdout") {
        stdout.push(chunk.toString("utf-8"));
      } else {
        stderr.push(chunk.toString("utf-8"));
      }
    },
  }).then((result) => ({
    result,
    stdout: stdout.join(""),
    stderr: stderr.join(""),
  }));
}

/** Wait until a pid no longer accepts signal 0 (i.e. the process is gone). */
async function waitForGone(pid: number, timeoutMs = 2000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await sleep(20);
  }
  return false;
}

describe(runShell, () => {
  test(
    "should capture both streams and the exit code",
    { skip: IS_WINDOWS },
    async () => {
      const { result, stdout, stderr } = await run(
        "printf out; printf err >&2; exit 0"
      );

      expect(result).toMatchObject({
        exitCode: 0,
        signal: null,
        timedOut: false,
        aborted: false,
      });
      expect(stdout).toBe("out");
      expect(stderr).toBe("err");
    }
  );

  test(
    "should report a non-zero exit as data",
    { skip: IS_WINDOWS },
    async () => {
      const { result } = await run("exit 7", { timeoutMs: 2000 });
      expect(result.exitCode).toBe(7);
      expect(result.timedOut).toBeFalsy();
    }
  );

  test(
    "should escalate to SIGKILL when the command ignores SIGTERM",
    { skip: IS_WINDOWS },
    async () => {
      const { result } = await run("trap '' TERM; sleep 5", {
        timeoutMs: 100,
        graceMs: 100,
      });

      expect(result.timedOut).toBeTruthy();
      expect(result.aborted).toBeFalsy();
      expect(result.signal).toBe("SIGKILL");
      expect(result.durationMs).toBeLessThan(3000);
    }
  );

  test(
    "should kill the command when the caller aborts",
    { skip: IS_WINDOWS },
    async () => {
      const controller = new AbortController();
      const pending = run("sleep 5", {
        timeoutMs: 5000,
        signal: controller.signal,
      });
      setTimeout(() => controller.abort(), 50);

      const { result } = await pending;

      expect(result.aborted).toBeTruthy();
      expect(result.timedOut).toBeFalsy();
      expect(result.durationMs).toBeLessThan(2000);
    }
  );

  test(
    "should not spawn when the signal is already aborted",
    { skip: IS_WINDOWS },
    async () => {
      const controller = new AbortController();
      controller.abort();
      const onSpawn = vi.fn<(pid: number) => void>();

      const { result } = await run("exit 0", {
        signal: controller.signal,
        onSpawn,
      });

      expect(result.aborted).toBeTruthy();
      expect(onSpawn).not.toHaveBeenCalled();
    }
  );

  test(
    "should return promptly when a descendant holds the pipe",
    { skip: IS_WINDOWS },
    async () => {
      const { result, stdout } = await run("sleep 0.5 & printf 'started\\n'", {
        timeoutMs: 3000,
        drainIdleMs: 100,
      });

      expect(stdout).toBe("started\n");
      expect(result.exitCode).toBe(0);
      expect(result.durationMs).toBeLessThan(800);
    }
  );

  test(
    "should reject when the working directory does not exist",
    { skip: IS_WINDOWS },
    async () => {
      await expect(
        run("printf hi", { cwd: "/definitely/not/a/directory" })
      ).rejects.toThrow(/ENOENT/u);
    }
  );

  test(
    "should reject when the executable cannot start",
    { skip: IS_WINDOWS },
    async () => {
      await expect(
        runShell({
          file: "/definitely/not/an/executable",
          args: [],
          cwd: process.cwd(),
          env: process.env,
          timeoutMs: 1000,
          onData: () => {},
        })
      ).rejects.toThrow(/ENOENT/u);
    }
  );

  test(
    "should leave no process behind after a timeout",
    { skip: IS_WINDOWS },
    async () => {
      let pid: number | undefined;
      const { result } = await run("sleep 5", {
        timeoutMs: 100,
        graceMs: 100,
        onSpawn: (spawned) => {
          pid = spawned;
        },
      });

      expect(result.timedOut).toBeTruthy();
      expect(pid).toBeDefined();
      await expect(waitForGone(pid!)).resolves.toBeTruthy();
    }
  );

  test(
    "should not keep the deadline armed after a quick exit",
    { skip: IS_WINDOWS },
    async () => {
      const { result } = await run("exit 0", { timeoutMs: 5000 });
      expect(result.durationMs).toBeLessThan(1000);
      expect(result.timedOut).toBeFalsy();
    }
  );
});
