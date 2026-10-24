import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import type { ApiServerStatus } from "@workspace/shared/api-status";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DesktopServer } from "../src/server-manager";

/* oxlint-disable unicorn/prefer-event-target */

class FakeChild extends EventEmitter {
  readonly pid = 1234;
  readonly stderr = new PassThrough();
  readonly stdout = new PassThrough();
  killed = false;

  kill(): boolean {
    this.killed = true;
    this.emit("exit", 0);
    return true;
  }

  sendReady(origin: string): void {
    this.stdout.write(`${JSON.stringify({ origin, type: "ready" })}\n`);
  }

  crash(code = 1): void {
    this.emit("exit", code);
  }
}

const { fork } = vi.hoisted(() => ({ fork: vi.fn<() => FakeChild>() }));

// @ts-expect-error -- the test only needs `utilityProcess`, not the whole module
vi.mock(import("electron"), () => ({
  utilityProcess: { fork },
}));

const children: FakeChild[] = [];
const servers: DesktopServer[] = [];
const originalMode = process.env.AIFY_SERVER_MODE;
const originalOrigin = process.env.AIFY_API_ORIGIN;

const createServer = (statuses: ApiServerStatus[]): DesktopServer => {
  const server = new DesktopServer({
    log: () => {},
    onStatus: (status) => statuses.push(status),
    token: () => "test-token",
  });

  servers.push(server);
  return server;
};

const spawnOptions = {
  cwd: process.cwd(),
  entry: process.execPath,
  env: {},
  port: 0,
};

describe("DesktopServer lifecycle", () => {
  beforeEach(() => {
    process.env.AIFY_SERVER_MODE = "owned";
    delete process.env.AIFY_API_ORIGIN;

    children.length = 0;
    fork.mockReset();
    fork.mockImplementation(() => {
      const child = new FakeChild();
      children.push(child);
      return child;
    });
  });

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(async (server) => await server.stop())
    );

    if (originalMode === undefined) {
      delete process.env.AIFY_SERVER_MODE;
    } else {
      process.env.AIFY_SERVER_MODE = originalMode;
    }
    if (originalOrigin === undefined) {
      delete process.env.AIFY_API_ORIGIN;
    } else {
      process.env.AIFY_API_ORIGIN = originalOrigin;
    }
  });

  it("reports starting and ready, then stops the owned child", async () => {
    const statuses: ApiServerStatus[] = [];
    const server = createServer(statuses);
    const started = server.start(spawnOptions);

    await vi.waitFor(() => {
      expect(fork).toHaveBeenCalledOnce();
    });

    const [child] = children;
    child.sendReady("http://127.0.0.1:12345");

    await expect(started).resolves.toBe("http://127.0.0.1:12345");
    expect(statuses).toContainEqual({ state: "starting" });
    expect(statuses).toContainEqual({
      origin: "http://127.0.0.1:12345",
      state: "ready",
    });

    await server.stop();

    expect(child.killed).toBeTruthy();
    expect(statuses.at(-1)).toStrictEqual({ state: "stopped" });
  });

  it("restarts once after an unexpected exit and reports the new origin", async () => {
    const statuses: ApiServerStatus[] = [];
    const server = createServer(statuses);
    const started = server.start(spawnOptions);

    await vi.waitFor(() => {
      expect(fork).toHaveBeenCalledOnce();
    });
    children[0].sendReady("http://127.0.0.1:12345");
    await started;

    children[0].crash(1);

    expect(statuses).toContainEqual({ state: "restarting" });

    await vi.waitFor(
      () => {
        expect(fork).toHaveBeenCalledTimes(2);
      },
      { timeout: 2000 }
    );

    children[1].sendReady("http://127.0.0.1:23456");

    await vi.waitFor(() => {
      expect(server.origin).toBe("http://127.0.0.1:23456");
    });

    expect(statuses).toContainEqual({
      origin: "http://127.0.0.1:23456",
      state: "ready",
    });
  });

  it("attaches to an external server and reports ready", async () => {
    const statuses: ApiServerStatus[] = [];
    const server = createServer(statuses);

    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    try {
      await expect(server.attach("http://127.0.0.1:18086")).resolves.toBe(
        "http://127.0.0.1:18086"
      );
    } finally {
      vi.unstubAllGlobals();
    }

    expect(statuses.at(-1)).toStrictEqual({
      origin: "http://127.0.0.1:18086",
      state: "ready",
    });
    expect(fork).not.toHaveBeenCalled();
  });
});
