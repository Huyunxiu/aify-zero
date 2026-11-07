/**
 * 真实 shell 的端到端验证：HTTP upgrade -> `/api/terminal` -> 真 PTY。
 *
 * 和 `terminal-websocket.test.ts` 的区别是这里不用假 PTY，用来确认
 * `@lydell/node-pty` 的实际读取、写入和退出路径。受限沙箱没有 `/dev/ptmx`
 * 时跳过。
 */
import type { Server } from "node:http";

import { serve } from "@hono/node-server";
import { encodeTerminalInput } from "@workspace/shared/terminal-protocol";
import { describe, expect, test } from "vitest";
import NodeWebSocket from "ws";

import { spawnShellPty } from "../src/terminal/pty";
import { attachWebSocket } from "../src/ws";
import { authHeaders, TEST_API_TOKEN, testApp } from "./helpers";

const isPtyUnavailable = (error: unknown): boolean =>
  error instanceof Error &&
  (error.message.includes("posix_openpt") ||
    error.message.includes("out of pty devices"));

interface Frame {
  readonly data: NodeWebSocket.RawData;
  readonly isBinary: boolean;
}

const frameText = (frame: Frame): string =>
  Array.isArray(frame.data)
    ? Buffer.concat(frame.data).toString("utf-8")
    : Buffer.from(frame.data as ArrayBuffer).toString("utf-8");

describe.skipIf(process.platform === "win32")("terminal real shell", () => {
  test("runs a command and returns its bytes", async (context) => {
    // 先探测一次 PTY，避免把沙箱限制当成协议失败。
    try {
      const probe = spawnShellPty({
        args: ["-c", "true"],
        cols: 80,
        cwd: process.cwd(),
        rows: 24,
        shell: "/bin/sh",
      });
      probe.kill();
    } catch (error) {
      if (isPtyUnavailable(error)) {
        context.skip();

        return;
      }

      throw error;
    }

    const { server, port } = await new Promise<{
      server: ReturnType<typeof serve>;
      port: number;
    }>((resolve) => {
      const created = serve(
        { fetch: testApp.fetch, hostname: "127.0.0.1", port: 0 },
        (info) => {
          resolve({ port: info.port, server: created });
        }
      );
    });
    const http = server as unknown as Server;
    const closeWebSocket = attachWebSocket(http, {
      apiToken: () => TEST_API_TOKEN,
      terminal: {
        resolveCwd: () => Promise.resolve(process.cwd()),
        spawn: (options) =>
          spawnShellPty({
            ...options,
            args: [],
            shell: "/bin/sh",
          }),
      },
    });

    const socket = new NodeWebSocket(
      `ws://127.0.0.1:${String(port)}/api/terminal?sessionId=e2e&cols=80&rows=24`,
      {
        headers: {
          authorization: authHeaders.authorization,
          origin: "http://127.0.0.1:3000",
        },
      }
    );

    try {
      const output = await new Promise<string>((resolve, reject) => {
        let received = "";
        const timer = setTimeout(() => {
          reject(new Error("real shell did not return the marker"));
        }, 5000);

        socket.on("message", (data, isBinary) => {
          const frame: Frame = { data, isBinary };

          if (!isBinary) {
            const control = JSON.parse(frameText(frame)) as {
              type?: string;
              message?: string;
            };

            if (control.type === "error") {
              clearTimeout(timer);
              reject(new Error(control.message ?? "terminal error"));
            }

            return;
          }

          received += frameText(frame);

          if (received.includes("PTY_OK")) {
            clearTimeout(timer);
            resolve(received);
          }
        });
        socket.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });

        socket.once("open", () => {
          socket.send(
            Buffer.from(encodeTerminalInput("printf 'PTY_%s\\n' OK\r"))
          );
        });
      });

      expect(output).toContain("PTY_OK");
    } finally {
      socket.close();
      await closeWebSocket();
      await new Promise<void>((resolve, reject) => {
        http.close((error) => {
          if (error) {
            reject(error);

            return;
          }

          resolve();
        });
      });
    }
  }, 10_000);
});
