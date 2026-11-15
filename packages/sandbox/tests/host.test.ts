import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, test } from "vitest";

import { defaultBashShell } from "../src/host/resolve.js";
import { HOST_BACKEND, createHostSandboxAdapter } from "../src/index.js";
import type { Sandbox } from "../src/index.js";
import { describeSandboxContract } from "../src/testing/contract.js";

const IS_WINDOWS = process.platform === "win32";
const IS_ROOT = typeof process.getuid === "function" && process.getuid() === 0;

const tempDirs: string[] = [];

/** 建一对临时目录：项目根和会话目录，`cwd` 取前者。 */
async function createTempRoots(): Promise<{
  root: string;
  session: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "aify-sandbox-host-"));
  tempDirs.push(root);
  const session = join(root, "session");
  await mkdir(session, { recursive: true });
  return { root, session };
}

/** 本机适配器上的一台沙箱，测试的公共起点。 */
async function createSandbox(): Promise<{
  root: string;
  sandbox: Sandbox;
}> {
  const { root, session } = await createTempRoots();
  const { sandbox } = await createHostSandboxAdapter().acquire({
    id: "session-1",
    projectDirs: [root],
    sessionDir: session,
  });
  return { root, sandbox };
}

/** 可选能力在契约里是可选的，测试里先断言存在再调用。 */
function requireReadTextStream(
  sandbox: Sandbox
): (path: string) => AsyncIterable<string> {
  const iterate = sandbox.readTextStream?.bind(sandbox);
  if (iterate === undefined) {
    throw new Error("host sandbox does not implement readTextStream");
  }
  return iterate;
}

function requireReadHead(
  sandbox: Sandbox
): (path: string, bytes: number) => Promise<Uint8Array> {
  const readHead = sandbox.readHead?.bind(sandbox);
  if (readHead === undefined) {
    throw new Error("host sandbox does not implement readHead");
  }
  return readHead;
}

describe("host sandbox", () => {
  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
    );
  });

  describe("acquire", () => {
    test("names the host backend", async () => {
      const { root, session } = await createTempRoots();
      const adapter = createHostSandboxAdapter();

      expect(adapter.name).toBe("host");

      const handle = await adapter.acquire({
        id: "session-a",
        projectDirs: [root],
        sessionDir: session,
      });

      expect(handle).not.toHaveProperty("physicalId");
      expect(handle.sandbox.describe().cwd).toBe(root);
    });

    test("rejects an empty project directory list", async () => {
      const { session } = await createTempRoots();

      await expect(
        createHostSandboxAdapter().acquire({
          id: "session-b",
          projectDirs: [],
          sessionDir: session,
        })
      ).rejects.toThrow("A sandbox needs at least one project directory.");
    });
  });

  describe("description", () => {
    test("reports the backend, cwd, and roots", async () => {
      const { root, session } = await createTempRoots();
      const { sandbox } = await createHostSandboxAdapter().acquire({
        id: "session-1",
        projectDirs: [root],
        sessionDir: session,
      });

      const description = sandbox.describe();

      expect(description.backend).toBe(HOST_BACKEND);
      expect(description.cwd).toBe(root);
      expect(description.roots).toStrictEqual([root, session]);
    });

    test("reports the shells that resolve", async () => {
      const { sandbox } = await createSandbox();
      const description = sandbox.describe();

      expect(description.shells.includes("bash")).toBe(
        defaultBashShell() !== undefined
      );
    });

    test.skipIf(IS_WINDOWS)("lists bash on POSIX", async () => {
      const { sandbox } = await createSandbox();

      expect(sandbox.describe().shells).toContain("bash");
    });

    test("computes the shell list on every call", async () => {
      const { sandbox } = await createSandbox();

      expect(sandbox.describe().shells).not.toBe(sandbox.describe().shells);
    });
  });

  describe("exec", () => {
    test("runs a command and reports the outcome", async () => {
      const { sandbox } = await createSandbox();

      const result = await sandbox.exec("echo hello");

      expect(result.exitCode).toBe(0);
      expect(result.signal).toBeNull();
      expect(result.timedOut).toBeFalsy();
      expect(result.aborted).toBeFalsy();
      expect(result.durationMs).toBeTypeOf("number");
    });

    test("streams stdout through onData", async () => {
      const { sandbox } = await createSandbox();
      const chunks: { channel: string; text: string }[] = [];

      await sandbox.exec("echo hello", {
        onData: (channel, chunk) => {
          chunks.push({ channel, text: chunk.toString("utf-8") });
        },
      });

      expect(
        chunks.some(
          (chunk) => chunk.channel === "stdout" && chunk.text.includes("hello")
        )
      ).toBeTruthy();
    });

    test("resolves a non-zero exit code instead of rejecting", async () => {
      const { sandbox } = await createSandbox();

      const result = await sandbox.exec("exit 7");

      expect(result.exitCode).toBe(7);
      expect(result.timedOut).toBeFalsy();
      expect(result.aborted).toBeFalsy();
    });

    test.skipIf(IS_WINDOWS)(
      "reports a timeout for a long command",
      async () => {
        const { sandbox } = await createSandbox();

        const result = await sandbox.exec("sleep 5", { timeoutMs: 300 });

        expect(result.timedOut).toBeTruthy();
        expect(result.exitCode).toBeNull();
        expect(result.durationMs).toBeLessThan(5000);
      }
    );

    test("does not run a command when the signal is already aborted", async () => {
      const { root, sandbox } = await createSandbox();
      const controller = new AbortController();
      controller.abort();
      const marker = join(root, "ran.txt");
      const chunks: string[] = [];

      const result = await sandbox.exec(`echo ran > ${marker}`, {
        signal: controller.signal,
        onData: (_channel, chunk) => {
          chunks.push(chunk.toString("utf-8"));
        },
      });

      expect(result.aborted).toBeTruthy();
      expect(result.exitCode).toBeNull();
      expect(result.timedOut).toBeFalsy();
      expect(chunks).toStrictEqual([]);
      await expect(sandbox.exists(marker)).resolves.toBeFalsy();
    });

    test.skipIf(IS_WINDOWS)(
      "rejects PowerShell where it is unavailable",
      async () => {
        const { sandbox } = await createSandbox();

        await expect(
          sandbox.exec("echo hello", { shell: "powershell" })
        ).rejects.toThrow("No PowerShell executable found.");
      }
    );

    test("rejects when the working directory does not exist", async () => {
      const { root, sandbox } = await createSandbox();

      await expect(
        sandbox.exec("echo hi", { cwd: join(root, "missing") })
      ).rejects.toThrow(/ENOENT/);
    });
  });

  describe("files", () => {
    test("writeFile creates parent directories and readFile round-trips", async () => {
      const { root, sandbox } = await createSandbox();
      const target = join(root, "a", "b", "c.txt");
      const content = "hello 世界\nsecond line\n";

      await sandbox.writeFile(target, content);

      await expect(sandbox.readFile(target)).resolves.toBe(content);

      await sandbox.writeFile("relative.txt", "relative");
      await expect(sandbox.readFile(join(root, "relative.txt"))).resolves.toBe(
        "relative"
      );
    });

    test("readFileBuffer returns the file bytes", async () => {
      const { root, sandbox } = await createSandbox();
      const target = join(root, "buffer.txt");
      await sandbox.writeFile(target, "hello");

      const bytes = await sandbox.readFileBuffer(target);

      expect(bytes).toBeInstanceOf(Uint8Array);
      expect(Buffer.from(bytes).toString("utf-8")).toBe("hello");
    });

    test("writeFile accepts raw bytes", async () => {
      const { root, sandbox } = await createSandbox();
      const target = join(root, "bytes.bin");

      await sandbox.writeFile(target, new Uint8Array([1, 2, 3]));
      const bytes = await sandbox.readFileBuffer(target);

      expect([...bytes]).toStrictEqual([1, 2, 3]);
    });

    test("stat describes a directory", async () => {
      const { root, sandbox } = await createSandbox();

      const info = await sandbox.stat(root);

      expect(info.isDirectory).toBeTruthy();
      expect(info.isFile).toBeFalsy();
      expect(info.isSymbolicLink).toBeFalsy();
      expect(info.size).toBeTypeOf("number");
      expect(info.mtime).toBeInstanceOf(Date);
    });

    test("stat describes a file", async () => {
      const { root, sandbox } = await createSandbox();
      await sandbox.writeFile(join(root, "stat.txt"), "abcde");

      const info = await sandbox.stat(join(root, "stat.txt"));

      expect(info.isFile).toBeTruthy();
      expect(info.isDirectory).toBeFalsy();
      expect(info.size).toBe(5);
      expect(info.mtime).toBeInstanceOf(Date);
    });

    test("stat rejects a missing path", async () => {
      const { root, sandbox } = await createSandbox();

      await expect(sandbox.stat(join(root, "missing"))).rejects.toThrow(
        /ENOENT/
      );
    });

    test.skipIf(IS_WINDOWS)("stat follows a symlink to a file", async () => {
      const { root, sandbox } = await createSandbox();
      await writeFile(join(root, "file.txt"), "abc");
      await symlink(join(root, "file.txt"), join(root, "link-file"));

      const info = await sandbox.stat(join(root, "link-file"));

      expect(info.isSymbolicLink).toBeTruthy();
      expect(info.isFile).toBeTruthy();
      expect(info.isDirectory).toBeFalsy();
      expect(info.size).toBe(3);
    });

    test.skipIf(IS_WINDOWS)(
      "stat follows a symlink to a directory",
      async () => {
        const { root, sandbox } = await createSandbox();
        await mkdir(join(root, "dir"));
        await symlink(join(root, "dir"), join(root, "link-dir"));

        const info = await sandbox.stat(join(root, "link-dir"));

        expect(info.isSymbolicLink).toBeTruthy();
        expect(info.isDirectory).toBeTruthy();
        expect(info.isFile).toBeFalsy();
      }
    );

    test.skipIf(IS_WINDOWS)("stat keeps a broken symlink", async () => {
      const { root, sandbox } = await createSandbox();
      await symlink(join(root, "gone"), join(root, "link-broken"));

      const info = await sandbox.stat(join(root, "link-broken"));

      expect(info.isSymbolicLink).toBeTruthy();
      expect(info.isFile).toBeFalsy();
      expect(info.isDirectory).toBeFalsy();
      expect(info.size).toBeUndefined();
      expect(info.mtime).toBeUndefined();
    });

    test.skipIf(IS_WINDOWS)("readdir reports each entry kind", async () => {
      const { root, sandbox } = await createSandbox();
      await sandbox.writeFile(join(root, "file.txt"), "x");
      await mkdir(join(root, "dir"));
      await symlink(join(root, "dir"), join(root, "link-dir"));
      await symlink(join(root, "file.txt"), join(root, "link-file"));

      const dirents = await sandbox.readdir(root);
      const entries = new Map(dirents.map((entry) => [entry.name, entry]));

      expect(entries.get("file.txt")).toStrictEqual({
        name: "file.txt",
        isFile: true,
        isDirectory: false,
        isSymbolicLink: false,
      });
      expect(entries.get("dir")).toStrictEqual({
        name: "dir",
        isFile: false,
        isDirectory: true,
        isSymbolicLink: false,
      });
      expect(entries.get("link-dir")).toStrictEqual({
        name: "link-dir",
        isFile: false,
        isDirectory: true,
        isSymbolicLink: true,
      });
      expect(entries.get("link-file")).toStrictEqual({
        name: "link-file",
        isFile: true,
        isDirectory: false,
        isSymbolicLink: true,
      });
    });

    test("exists never throws and reports presence", async () => {
      const { root, sandbox } = await createSandbox();
      await sandbox.writeFile(join(root, "present.txt"), "x");

      await expect(
        sandbox.exists(join(root, "present.txt"))
      ).resolves.toBeTruthy();
      await expect(sandbox.exists(join(root, "missing"))).resolves.toBeFalsy();
      await expect(
        sandbox.exists(join(root, "a", "b", "missing"))
      ).resolves.toBeFalsy();
      await expect(
        sandbox.exists(join(root, "present.txt"), { readable: true })
      ).resolves.toBeTruthy();
      await expect(
        sandbox.exists(join(root, "present.txt"), { writable: true })
      ).resolves.toBeTruthy();
    });

    test.skipIf(IS_WINDOWS || IS_ROOT)(
      "exists with writable is false for a read-only file",
      async () => {
        const { root, sandbox } = await createSandbox();
        const target = join(root, "readonly.txt");
        await writeFile(target, "x");
        await chmod(target, 0o444);

        await expect(
          sandbox.exists(target, { writable: true })
        ).resolves.toBeFalsy();
        await expect(
          sandbox.exists(target, { readable: true })
        ).resolves.toBeTruthy();
      }
    );

    test("readTextStream yields lines without newlines", async () => {
      const { root, sandbox } = await createSandbox();
      const target = join(root, "lines.txt");
      await sandbox.writeFile(target, "alpha\nbeta\r\ngamma");

      const lines: string[] = [];
      for await (const line of requireReadTextStream(sandbox)(target)) {
        lines.push(line);
      }

      expect(lines).toStrictEqual(["alpha", "beta", "gamma"]);
    });

    test("readHead returns only the requested prefix", async () => {
      const { root, sandbox } = await createSandbox();
      const target = join(root, "head.txt");
      await sandbox.writeFile(target, "0123456789");

      const head = await requireReadHead(sandbox)(target, 4);

      expect([...head]).toStrictEqual([48, 49, 50, 51]);
    });

    test("readHead clamps to the file size", async () => {
      const { root, sandbox } = await createSandbox();
      const target = join(root, "head.txt");
      await sandbox.writeFile(target, "0123456789");

      const head = await requireReadHead(sandbox)(target, 100);

      expect(Buffer.from(head).toString("utf-8")).toBe("0123456789");
    });

    test("resolvePath normalizes paths", async () => {
      const { root, sandbox } = await createSandbox();

      expect(sandbox.resolvePath("nested/file.txt")).toBe(
        join(root, "nested", "file.txt")
      );
      expect(sandbox.resolvePath("@nested/file.txt")).toBe(
        join(root, "nested", "file.txt")
      );
      expect(sandbox.resolvePath(join(root, "abs.txt"))).toBe(
        join(root, "abs.txt")
      );
      expect(sandbox.resolvePath(pathToFileURL(join(root, "x.txt")).href)).toBe(
        join(root, "x.txt")
      );
      expect(sandbox.resolvePath("~")).toBe(sandbox.resolvePath(homedir()));
    });
  });

  // 共享契约：所有适配器都要过这一份，断言只取自 types.ts 的文档注释。
  describeSandboxContract({
    name: "host",
    create: async () => {
      const { sandbox } = await createSandbox();
      return sandbox;
    },
  });
});
