import { HOST_BACKEND } from "@workspace/sandbox";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  acquireSessionSandbox,
  clearSessionSandboxes,
} from "../src/sandbox/registry";

const input = (sessionId: string) => ({
  sessionId,
  projectDirs: ["/tmp"],
  sessionDir: "/tmp/sessions",
});

describe(acquireSessionSandbox, () => {
  afterEach(async () => {
    vi.unstubAllEnvs();
    await clearSessionSandboxes();
  });

  test("should return the same sandbox for the same session", async () => {
    const first = await acquireSessionSandbox(input("session-shared"));
    const second = await acquireSessionSandbox(input("session-shared"));

    expect(second).toBe(first);
  });

  test("should give different sessions different sandboxes", async () => {
    const first = await acquireSessionSandbox(input("session-a"));
    const second = await acquireSessionSandbox(input("session-b"));

    expect(second).not.toBe(first);
  });

  test("should not cache a failed acquisition", async () => {
    const bad = { ...input("session-broken"), projectDirs: [] };
    await expect(acquireSessionSandbox(bad)).rejects.toThrow(
      "A sandbox needs at least one project directory."
    );

    // 失败条目已经删掉，下一次调用重新建。
    const sandbox = await acquireSessionSandbox(input("session-broken"));
    expect(sandbox.describe().cwd).toBe("/tmp");
  });

  test("should reject an unknown adapter instead of falling back", async () => {
    vi.stubEnv("AIFY_SANDBOX_ADAPTER", "docker");

    await expect(
      acquireSessionSandbox(input("session-unknown"))
    ).rejects.toThrow('Unknown AIFY_SANDBOX_ADAPTER: "docker"');
  });

  test("should reject an unknown explicit Bot sandbox adapter instead of falling back", async () => {
    await expect(
      acquireSessionSandbox({
        ...input("session-bot-unknown"),
        sandbox: {
          adapter: "docker" as unknown as "host",
          isolateHome: false,
        },
      })
    ).rejects.toThrow('Unknown sandbox adapter: "docker"');
  });

  test("should rebuild only the session whose Bot sandbox config changed", async () => {
    const sessionA1 = await acquireSessionSandbox({
      ...input("rebuild-a"),
      env: { TOKEN: "v1" },
      sandbox: { adapter: "host", isolateHome: false },
    });
    const sessionB1 = await acquireSessionSandbox({
      ...input("rebuild-b"),
      env: { OTHER: "keep" },
      sandbox: { adapter: "host", isolateHome: false },
    });

    const sessionA2 = await acquireSessionSandbox({
      ...input("rebuild-a"),
      env: { TOKEN: "v2" },
      sandbox: { adapter: "host", isolateHome: false },
    });
    const sessionB2 = await acquireSessionSandbox({
      ...input("rebuild-b"),
      env: { OTHER: "keep" },
      sandbox: { adapter: "host", isolateHome: false },
    });

    expect(sessionA2).not.toBe(sessionA1);
    expect(sessionB2).toBe(sessionB1);
  });

  test("should refuse the isolated backend when isolation is unavailable", async () => {
    vi.stubEnv("AIFY_SANDBOX_ADAPTER", "isolated");

    // 这台机器能套上隔离时这条报的是平台机制（macOS 的 seatbelt、Linux 的
    // bwrap），不能是本机；套不上时必须明确失败，不静默降级成无隔离执行。
    await acquireSessionSandbox(input("session-isolated")).then(
      (sandbox) => {
        expect(sandbox.describe().backend).not.toBe(HOST_BACKEND);
      },
      (error: unknown) => {
        expect(String(error)).toContain("Native isolation is unavailable");
      }
    );
  });
});
