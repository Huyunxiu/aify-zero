/**
 * `fake.ts` 的测试：先跑通用契约，再测只有内存实现才有的观察点。
 */
import { describe, expect, test } from "vitest";

import { SandboxOperationUnsupportedError } from "../src/errors.js";
import { describeSandboxContract } from "../src/testing/contract.js";
import {
  createFakeSandbox,
  createFakeSandboxAdapter,
} from "../src/testing/fake.js";

// 标准节点：一个 bash 沙箱，带预置文件和目录。
describeSandboxContract({
  name: "fake",
  create: () =>
    createFakeSandbox({
      dirs: ["seed/empty"],
      files: {
        "seed/big.txt": "0123456789",
        "seed/readme.txt": "seeded",
      },
    }),
});

// 没有 shell 的节点：exec 用例应带说明跳过，「无 shell 时抛不支持」用例生效。
describeSandboxContract({
  name: "fake without shells",
  create: () => createFakeSandbox({ shells: [] }),
});

// 缺可选能力的节点：流式读和读头用例应带说明跳过。
describeSandboxContract({
  name: "fake without optional verbs",
  create: () =>
    createFakeSandbox({ withoutHead: true, withoutStreaming: true }),
});

describe("fake sandbox helpers", () => {
  test("should record every exec call in order", async () => {
    const sandbox = createFakeSandbox();
    await sandbox.exec("echo hello");
    await sandbox.exec("echo world", { env: { LANG: "C" } });

    expect(sandbox.calls).toStrictEqual([
      { command: "echo hello" },
      { command: "echo world", options: { env: { LANG: "C" } } },
    ]);
  });

  test("should delegate exec to the supplied override", async () => {
    const sandbox = createFakeSandbox({
      exec: (command) =>
        Promise.resolve({
          aborted: false,
          durationMs: 5,
          exitCode: command === "boom" ? 2 : 0,
          signal: null,
          timedOut: false,
        }),
    });

    await expect(sandbox.exec("boom")).resolves.toMatchObject({
      durationMs: 5,
      exitCode: 2,
    });
    expect(sandbox.calls).toHaveLength(1);
  });

  test("should give each sandbox id a fresh sandbox and a physical id", async () => {
    const adapter = createFakeSandboxAdapter({
      files: { "seed.txt": "seed" },
    });
    expect(adapter.name).toBe("fake");

    const first = await adapter.acquire({
      id: "session-1",
      projectDirs: ["/workspace"],
      sessionDir: "/tmp/session-1",
    });
    const second = await adapter.acquire({
      id: "session-2",
      projectDirs: ["/workspace"],
      sessionDir: "/tmp/session-2",
    });

    expect(first.physicalId).toBe("fake-session-1");
    expect(second.physicalId).toBe("fake-session-2");
    expect(first.sandbox).not.toBe(second.sandbox);

    // 两个沙箱互不可见，证明「每个 id 一份」。
    await first.sandbox.writeFile(
      first.sandbox.resolvePath("only-first.txt"),
      "x"
    );
    await expect(
      second.sandbox.exists(second.sandbox.resolvePath("only-first.txt"))
    ).resolves.toBeFalsy();
  });

  test("should pass seed files through the adapter", async () => {
    const adapter = createFakeSandboxAdapter({ files: { "seed.txt": "seed" } });
    const { sandbox } = await adapter.acquire({
      id: "seeded",
      projectDirs: ["/workspace"],
      sessionDir: "/tmp/seeded",
    });
    await expect(
      sandbox.readFile(sandbox.resolvePath("seed.txt"))
    ).resolves.toBe("seed");
  });

  test("should omit readTextStream and readHead when they are disabled", () => {
    const sandbox = createFakeSandbox({
      withoutHead: true,
      withoutStreaming: true,
    });
    expect("readTextStream" in sandbox).toBeFalsy();
    expect("readHead" in sandbox).toBeFalsy();
  });

  test("should define readTextStream and readHead by default", () => {
    const sandbox = createFakeSandbox();
    expect(sandbox.readTextStream?.bind(sandbox)).toBeTypeOf("function");
    expect(sandbox.readHead?.bind(sandbox)).toBeTypeOf("function");
  });

  test("should advertise no shells and refuse exec without one", async () => {
    const sandbox = createFakeSandbox({ shells: [] });
    expect(sandbox.describe().shells).toStrictEqual([]);
    await expect(sandbox.exec("true")).rejects.toBeInstanceOf(
      SandboxOperationUnsupportedError
    );
    await expect(sandbox.exec("true")).rejects.toMatchObject({
      backend: "fake",
      operation: "exec",
    });
  });

  test("should normalize `@`, `~`, and `file://` inputs", () => {
    const sandbox = createFakeSandbox();
    expect(sandbox.resolvePath("@notes.txt")).toBe("/workspace/notes.txt");
    expect(sandbox.resolvePath("~/notes.txt")).toBe("/home/user/notes.txt");
    expect(sandbox.resolvePath("file:///workspace/notes.txt")).toBe(
      "/workspace/notes.txt"
    );
  });

  test("should sort readdir entries by name", async () => {
    const sandbox = createFakeSandbox({
      files: { "z.txt": "z", "a.txt": "a" },
    });
    const entries = await sandbox.readdir("/workspace");
    expect(entries.map((entry) => entry.name)).toStrictEqual([
      "a.txt",
      "z.txt",
    ]);
  });

  test("should attach a code to missing-path errors", async () => {
    const sandbox = createFakeSandbox();
    const failure = await sandbox
      .stat("/workspace/missing.txt")
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "ENOENT" });
  });

  test("should seed relative paths against cwd", async () => {
    const sandbox = createFakeSandbox({ files: { "nested/seed.txt": "x" } });
    await expect(
      sandbox.readFile(sandbox.resolvePath("nested/seed.txt"))
    ).resolves.toBe("x");
    await expect(
      sandbox.exists("/workspace/nested/seed.txt")
    ).resolves.toBeTruthy();
  });
});
