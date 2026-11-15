/**
 * 可复用的沙箱契约测试。
 *
 * 每个适配器都跑这一份，断言只来自 `types.ts` 的文档注释，不碰实现细节。新增
 * 适配器时把它接到这里，就能知道自己的行为是否和工具期待的一致。
 */
import { isAbsolute } from "node:path";

import { beforeEach, describe, expect, test } from "vitest";

import { SandboxOperationUnsupportedError } from "../errors";
import type { Sandbox } from "../types";

/**
 * 契约里定义的 shell 方言。`describe().shells` 只能列出这些值，空数组表示
 * 这个沙箱只能读写文件。
 */
const SHELL_KINDS = ["bash", "powershell", "cmd"];

/**
 * 给一个沙箱节点挂上契约测试。
 *
 * `create` 每次调用都要给一份干净的沙箱：每个用例在 `beforeEach` 里各拿一份。
 */
export function describeSandboxContract(node: {
  name: string;
  create: () => Promise<Sandbox> | Sandbox;
}): void {
  describe(`sandbox contract: ${node.name}`, () => {
    let sandbox: Sandbox;

    beforeEach(async () => {
      sandbox = await node.create();
    });

    test("should describe a usable sandbox", () => {
      const description = sandbox.describe();
      expect(description.backend.length).toBeGreaterThan(0);
      expect(description.cwd.length).toBeGreaterThan(0);
      expect(description.roots.length).toBeGreaterThan(0);
      expect(description.roots).toContain(description.cwd);
      for (const shell of description.shells) {
        expect(SHELL_KINDS).toContain(shell);
      }
    });

    test("should round-trip UTF-8 text and report the byte length", async () => {
      const target = sandbox.resolvePath("utf8.txt");
      // 多字节字符：字节数和字符数不相等。
      const text = "hello 世界 🐳";
      await sandbox.writeFile(target, text);
      await expect(sandbox.readFile(target)).resolves.toBe(text);
      const bytes = await sandbox.readFileBuffer(target);
      expect(bytes.byteLength).toBe(Buffer.byteLength(text, "utf-8"));
      expect(bytes.byteLength).not.toBe(text.length);
    });

    test("should create missing parent directories on write", async () => {
      const target = sandbox.resolvePath("nested/one/two/deep.txt");
      await sandbox.writeFile(target, "deep");
      await expect(sandbox.readFile(target)).resolves.toBe("deep");
      const parent = await sandbox.stat(sandbox.resolvePath("nested/one/two"));
      expect(parent.isDirectory).toBe(true);
    });

    test("should reject stat and resolve false for exists on a missing path", async () => {
      const target = sandbox.resolvePath("missing/never-created.txt");
      await expect(sandbox.stat(target)).rejects.toThrow();
      // `exists` 永不抛：不存在就是 `false`。
      await expect(sandbox.exists(target)).resolves.toBe(false);
    });

    test("should report file and directory kinds from stat", async () => {
      const target = sandbox.resolvePath("stat-file.txt");
      const content = "abc";
      await sandbox.writeFile(target, content);
      const fileStat = await sandbox.stat(target);
      expect(fileStat.isFile).toBe(true);
      expect(fileStat.isDirectory).toBe(false);
      // 适配器报得出大小时，必须是字节数。
      if (fileStat.size !== undefined) {
        expect(fileStat.size).toBe(Buffer.byteLength(content, "utf-8"));
      }

      const directory = sandbox.resolvePath("stat-dir");
      await sandbox.mkdir(directory, { recursive: true });
      const directoryStat = await sandbox.stat(directory);
      expect(directoryStat.isFile).toBe(false);
      expect(directoryStat.isDirectory).toBe(true);
    });

    test("should list directory children without dot entries", async () => {
      const directory = sandbox.resolvePath("listing");
      await sandbox.mkdir(directory, { recursive: true });
      await sandbox.writeFile(sandbox.resolvePath("listing/child.txt"), "x");
      await sandbox.mkdir(sandbox.resolvePath("listing/sub"), {
        recursive: true,
      });

      const entries = await sandbox.readdir(directory);
      const names = entries.map((entry) => entry.name);
      expect(names).not.toContain(".");
      expect(names).not.toContain("..");
      expect(names).toContain("child.txt");
      expect(names).toContain("sub");

      const child = entries.find((entry) => entry.name === "child.txt");
      expect(child?.isFile).toBe(true);
      expect(child?.isDirectory).toBe(false);

      const sub = entries.find((entry) => entry.name === "sub");
      expect(sub?.isFile).toBe(false);
      expect(sub?.isDirectory).toBe(true);
    });

    test("should accept a recursive mkdir twice", async () => {
      const directory = sandbox.resolvePath("mkdir-once");
      await sandbox.mkdir(directory, { recursive: true });
      // 递归建已存在的目录是幂等的。
      await expect(
        sandbox.mkdir(directory, { recursive: true })
      ).resolves.toBeUndefined();
    });

    test("should require force for a missing path and remove a subtree", async () => {
      const missing = sandbox.resolvePath("rm-missing.txt");
      await expect(sandbox.rm(missing)).rejects.toThrow();
      await expect(
        sandbox.rm(missing, { force: true })
      ).resolves.toBeUndefined();

      const tree = sandbox.resolvePath("rm-tree");
      const leaf = sandbox.resolvePath("rm-tree/inner/leaf.txt");
      await sandbox.writeFile(leaf, "leaf");
      await sandbox.rm(tree, { recursive: true });
      await expect(sandbox.exists(tree)).resolves.toBe(false);
      await expect(sandbox.exists(leaf)).resolves.toBe(false);
    });

    test("should answer exists with and without access requirements", async () => {
      const target = sandbox.resolvePath("exists.txt");
      const missing = sandbox.resolvePath("missing.txt");

      expect(await sandbox.exists(target)).toBe(false);
      await sandbox.writeFile(target, "here");

      expect(await sandbox.exists(target)).toBe(true);
      expect(await sandbox.exists(missing)).toBe(false);
      // 可读可写的检查只回答布尔，不抛：写不出去时调用方靠 `stat` 找原因。
      await expect(
        sandbox.exists(target, { readable: true, writable: true })
      ).resolves.toBe(true);
      await expect(
        sandbox.exists(missing, { readable: true, writable: true })
      ).resolves.toBe(false);
    });

    test("should resolve a relative path to an absolute path under cwd", () => {
      const relative = sandbox.resolvePath("relative/deep.txt");
      expect(isAbsolute(relative)).toBe(true);
      expect(relative.startsWith(sandbox.resolvePath("."))).toBe(true);
      // 绝对路径再解析一次必须不变。
      expect(sandbox.resolvePath(relative)).toBe(relative);
    });

    test("should resolve a non-zero exit code as a result", async ({
      skip,
    }) => {
      if (sandbox.describe().shells.length === 0) {
        skip("sandbox has no shell; exec is not supported");
      }
      const result = await sandbox.exec("exit 7");
      expect(result.exitCode).toBe(7);
      expect(result.timedOut).toBe(false);
      expect(result.aborted).toBe(false);
    });

    test("should report an aborted exec without rejecting", async ({
      skip,
    }) => {
      if (sandbox.describe().shells.length === 0) {
        skip("sandbox has no shell; exec is not supported");
      }
      const controller = new AbortController();
      controller.abort();
      const result = await sandbox.exec("exit 0", {
        signal: controller.signal,
      });
      expect(result.aborted).toBe(true);
    });

    test("should stream text lines without trailing newlines", async ({
      skip,
    }) => {
      const stream = sandbox.readTextStream?.bind(sandbox);
      if (stream === undefined) {
        skip("readTextStream is not implemented by this sandbox");
      } else {
        const target = sandbox.resolvePath("stream.txt");
        await sandbox.writeFile(target, "first\nsecond\n");
        const lines: string[] = [];
        for await (const line of stream(target)) {
          lines.push(line);
        }
        expect(lines).toStrictEqual(["first", "second"]);
        expect(lines.some((line) => line.endsWith("\n"))).toBeFalsy();
      }
    });

    test("should read at most the requested head bytes", async ({ skip }) => {
      const readHead = sandbox.readHead?.bind(sandbox);
      if (readHead === undefined) {
        skip("readHead is not implemented by this sandbox");
      } else {
        const target = sandbox.resolvePath("head.bin");
        await sandbox.writeFile(target, "0123456789");
        const head = await readHead(target, 4);
        expect(head.byteLength).toBeLessThanOrEqual(4);
        // 返回的字节必须是文件开头那一段。
        const full = await sandbox.readFileBuffer(target);
        expect(full.slice(0, head.byteLength)).toStrictEqual(head);
      }
    });

    test("should throw when exec has no shell to run", async ({ skip }) => {
      if (sandbox.describe().shells.length > 0) {
        skip("sandbox has a shell; exec is supported");
      }
      // 没有 shell 时 `exec` 抛能力错误，而不是 reject 一条命令结果。
      let failure: unknown = null;
      try {
        await sandbox.exec("true");
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(SandboxOperationUnsupportedError);
      expect(failure).toMatchObject({ operation: "exec" });
    });
  });
}
