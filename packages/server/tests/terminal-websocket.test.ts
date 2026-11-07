/**
 * `/api/terminal` 的端到端验证。
 *
 * 这里起真的 HTTP server 和真的 `ws` 客户端；只有 PTY 是假的，测试才能精确
 * 控制输出、退出和关闭时机，同时不依赖本机的 shell。
 */
import type { Server } from "node:http";

import { serve } from "@hono/node-server";
import {
  encodeTerminalControl,
  encodeTerminalInput,
} from "@workspace/shared/terminal-protocol";
import { describe, expect, test, vi } from "vitest";
import NodeWebSocket from "ws";

import type { TerminalPty, TerminalSubscription } from "../src/terminal/pty";
import { attachWebSocket } from "../src/ws";
import { authHeaders, TEST_API_TOKEN, testApp } from "./helpers";

/** 测试用的假 PTY：记录写入和 resize，手动触发输出与退出。 */
class FakePty implements TerminalPty {
  readonly pid = 4321;
  readonly resized: [number, number][] = [];
  readonly written: Buffer[] = [];
  killed = false;
  paused = false;

  readonly #dataListeners = new Set<(data: Buffer) => void>();
  readonly #exitListeners = new Set<(event: { exitCode: number }) => void>();

  kill(): void {
    this.killed = true;
  }

  onData(listener: (data: Buffer) => void): TerminalSubscription {
    this.#dataListeners.add(listener);

    return { dispose: () => this.#dataListeners.delete(listener) };
  }

  onExit(
    listener: (event: { exitCode: number }) => void
  ): TerminalSubscription {
    this.#exitListeners.add(listener);

    return { dispose: () => this.#exitListeners.delete(listener) };
  }

  pause(): void {
    this.paused = true;
  }

  resize(cols: number, rows: number): void {
    this.resized.push([cols, rows]);
  }

  resume(): void {
    this.paused = false;
  }

  write(data: Uint8Array): void {
    this.written.push(Buffer.from(data));
  }

  emitData(text: string): void {
    for (const listener of this.#dataListeners) {
      listener(Buffer.from(text));
    }
  }

  emitExit(exitCode: number): void {
    for (const listener of this.#exitListeners) {
      listener({ exitCode });
    }
  }
}

interface Harness {
  readonly fake: FakePty;
  readonly origin: string;
  readonly stop: () => Promise<void>;
}

const start = async (options?: {
  maxSessions?: number;
  resolveCwd?: (sessionId: string) => Promise<string>;
}): Promise<Harness> => {
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
  const fake = new FakePty();
  const closeWebSocket = attachWebSocket(http, {
    apiToken: () => TEST_API_TOKEN,
    terminal: {
      maxSessions: options?.maxSessions,
      resolveCwd: options?.resolveCwd ?? (() => Promise.resolve(process.cwd())),
      spawn: () => fake,
    },
  });

  return {
    fake,
    origin: `http://127.0.0.1:${String(port)}`,
    stop: async () => {
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
    },
  };
};

interface ConnectOptions {
  readonly authorization?: string;
  readonly origin?: string;
  readonly query?: string;
}

interface Frame {
  readonly data: NodeWebSocket.RawData;
  readonly isBinary: boolean;
}

interface TerminalClient {
  close(): void;
  nextClose(): Promise<number>;
  nextFrame(): Promise<Frame>;
  send(data: Uint8Array): void;
}

/**
 * 升级一条连接；默认带上 token 和本机页面来源。
 *
 * 消息可能在 `open` 之后立刻到达，测试还没开始 `nextFrame` 就已经错过。这里
 * 在构造时就开始排队，`nextFrame` 先取队列。
 */
const connect = (
  origin: string,
  options: ConnectOptions = {}
): Promise<TerminalClient> =>
  new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      origin: options.origin ?? "http://127.0.0.1:3000",
    };

    if (options.authorization !== undefined) {
      headers.authorization = options.authorization;
    }

    const socket = new NodeWebSocket(
      `${origin.replace("http", "ws")}/api/terminal?${options.query ?? "sessionId=session-1"}`,
      { headers }
    );
    const frames: Frame[] = [];
    const waiters: ((frame: Frame) => void)[] = [];
    const closed = new Promise<number>((_resolve) => {
      socket.once("close", (code: number) => {
        _resolve(code);
      });
    });

    socket.on("message", (data, isBinary) => {
      const frame: Frame = { data, isBinary };
      const waiter = waiters.shift();

      if (waiter === undefined) {
        frames.push(frame);
      } else {
        waiter(frame);
      }
    });

    socket.once("open", () => {
      resolve({
        close: () => {
          socket.close();
        },
        nextClose: () => closed,
        nextFrame: () => {
          const frame = frames.shift();

          if (frame !== undefined) {
            return Promise.resolve(frame);
          }

          return new Promise<Frame>((_resolve) => {
            waiters.push(_resolve);
          });
        },
        send: (data) => {
          socket.send(data);
        },
      });
    });
    socket.once("error", reject);
  });

const textOf = (frame: Frame): unknown =>
  JSON.parse(
    Array.isArray(frame.data)
      ? Buffer.concat(frame.data).toString("utf-8")
      : Buffer.from(frame.data as ArrayBuffer).toString("utf-8")
  ) as unknown;

const bytesOf = (frame: Frame): Buffer =>
  Array.isArray(frame.data)
    ? Buffer.concat(frame.data)
    : Buffer.from(frame.data as ArrayBuffer);

describe("terminal websocket", () => {
  test("refuses an upgrade without a token", async () => {
    const { origin, stop } = await start();

    try {
      await expect(connect(origin)).rejects.toThrow(/401/);
    } finally {
      await stop();
    }
  });

  test("refuses a foreign browser origin", async () => {
    const { origin, stop } = await start();

    try {
      await expect(
        connect(origin, {
          authorization: authHeaders.authorization,
          origin: "https://evil.example",
        })
      ).rejects.toThrow(/403/);
    } finally {
      await stop();
    }
  });

  test("requires a session id", async () => {
    const { origin, stop } = await start();

    try {
      await expect(
        connect(origin, {
          authorization: authHeaders.authorization,
          query: "",
        })
      ).rejects.toThrow(/400/);
    } finally {
      await stop();
    }
  });

  test("writes input bytes to the PTY and sends output as binary", async () => {
    const { fake, origin, stop } = await start();
    const client = await connect(origin, {
      authorization: authHeaders.authorization,
    });

    try {
      const ready = await client.nextFrame();

      expect(ready.isBinary).toBeFalsy();
      expect(textOf(ready)).toStrictEqual({
        cwd: process.cwd(),
        pid: fake.pid,
        type: "ready",
      });

      client.send(Buffer.from(encodeTerminalInput("ls\r")));
      await vi.waitFor(() => {
        expect(
          fake.written.map((value) => value.toString("utf-8"))
        ).toStrictEqual(["ls\r"]);
      });

      const output = client.nextFrame();
      fake.emitData("file-one\r\n");
      const received = await output;

      expect(received.isBinary).toBeTruthy();
      expect(bytesOf(received).toString("utf-8")).toBe("file-one\r\n");
    } finally {
      client.close();
      await stop();
    }
  });

  test("applies resize control frames", async () => {
    const { fake, origin, stop } = await start();
    const client = await connect(origin, {
      authorization: authHeaders.authorization,
      query: "sessionId=session-1&cols=80&rows=24",
    });

    try {
      await client.nextFrame();

      client.send(
        Buffer.from(
          encodeTerminalControl({ cols: 120, rows: 40, type: "resize" })
        )
      );

      await vi.waitFor(() => {
        expect(fake.resized).toStrictEqual([[120, 40]]);
      });
    } finally {
      client.close();
      await stop();
    }
  });

  test("reports the exit code and closes the connection", async () => {
    const { fake, origin, stop } = await start();
    const client = await connect(origin, {
      authorization: authHeaders.authorization,
    });

    try {
      await client.nextFrame();
      const exitFrame = client.nextFrame();

      fake.emitExit(7);

      const exit = await exitFrame;

      expect(exit.isBinary).toBeFalsy();
      expect(textOf(exit)).toStrictEqual({ exitCode: 7, type: "exit" });
      await expect(client.nextClose()).resolves.toBe(1000);
    } finally {
      client.close();
      await stop();
    }
  });

  test("kills the PTY when the client closes", async () => {
    const { fake, origin, stop } = await start();
    const client = await connect(origin, {
      authorization: authHeaders.authorization,
    });

    try {
      await client.nextFrame();
      expect(fake.killed).toBeFalsy();

      client.close();

      await vi.waitFor(() => {
        expect(fake.killed).toBeTruthy();
      });
    } finally {
      await stop();
    }
  });

  test("rejects a second session when the limit is reached", async () => {
    const { origin, stop } = await start({ maxSessions: 1 });
    const client = await connect(origin, {
      authorization: authHeaders.authorization,
    });

    try {
      await client.nextFrame();

      await expect(
        connect(origin, { authorization: authHeaders.authorization })
      ).rejects.toThrow(/429/);
    } finally {
      client.close();
      await stop();
    }
  });
});
