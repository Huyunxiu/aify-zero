/**
 * 真实 `@lydell/node-pty` 的冒烟测试。
 *
 * 这个测试不经过 WebSocket，只验证原生包在当前平台能加载，并且适配器能收到
 * 字节和退出码。Windows 的 ConPTY 行为不同，本次不做实机验收。
 */
import { describe, expect, test } from "vitest";

import { spawnShellPty } from "../src/terminal/pty";
import type { TerminalPty } from "../src/terminal/pty";

/** 受限沙箱会禁用 `/dev/ptmx`；这时跳过，而不是把环境限制当成代码失败。 */
const isPtyUnavailable = (error: unknown): boolean =>
  error instanceof Error &&
  (error.message.includes("posix_openpt") ||
    error.message.includes("out of pty devices"));

describe.skipIf(process.platform === "win32")("terminal pty adapter", () => {
  test("streams output and reports the exit code", async (context) => {
    let pty: TerminalPty;

    try {
      pty = spawnShellPty({
        args: ["-c", "printf ready"],
        cols: 80,
        cwd: process.cwd(),
        rows: 24,
        shell: "/bin/sh",
      });
    } catch (error) {
      if (isPtyUnavailable(error)) {
        context.skip();

        return;
      }

      throw error;
    }

    try {
      const result = await new Promise<{ exitCode: number; output: string }>(
        (resolve, reject) => {
          let output = "";
          const timer = setTimeout(() => {
            reject(new Error("PTY did not exit in time"));
          }, 5000);

          pty.onData((data) => {
            output += data.toString("utf-8");
          });
          pty.onExit(({ exitCode }) => {
            clearTimeout(timer);
            resolve({ exitCode, output });
          });
        }
      );

      expect(result.output).toContain("ready");
      expect(result.exitCode).toBe(0);
    } finally {
      pty.kill();
    }
  });
});
