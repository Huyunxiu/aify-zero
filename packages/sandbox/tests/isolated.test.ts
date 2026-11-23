import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { SandboxPathDeniedError } from "../src/errors";
import {
  createIsolatedSandboxAdapter,
  probeNativeIsolation,
} from "../src/index";
import {
  SEATBELT_BINARY,
  buildBwrapInvocation,
  buildSeatbeltInvocation,
  buildSeatbeltProfile,
  buildWritePolicy,
  detectBackend,
  isWritablePath,
} from "../src/isolated/policy";
import { describeSandboxContract } from "../src/testing/contract";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "aify-sbx-isolated-"));
  tempDirs.push(dir);
  return dir;
}

/**
 * 越界的文件动词必须抛 `SandboxPathDeniedError`。
 *
 * 断言的是「哪一次调用被拒」，不是文案：文案归 `errors.ts` 管，测试盯住它会把
 * 一条措辞改动变成一次红。
 */
async function expectPathDenied(
  call: Promise<unknown>,
  operation: string
): Promise<void> {
  const reason = await call.then(
    () => null,
    (error: unknown) => error
  );

  expect(reason).toBeInstanceOf(SandboxPathDeniedError);
  expect((reason as SandboxPathDeniedError).operation).toBe(operation);
}

describe(buildWritePolicy, () => {
  test("should include the project and session directories", () => {
    const roots = buildWritePolicy({
      projectDirs: ["/work/alpha"],
      sessionDir: "/work/.sessions/s1",
    });

    expect(roots).toContain("/work/alpha");
    expect(roots).toContain("/work/.sessions/s1");
  });

  test("should include the temp directory and build caches", () => {
    const roots = buildWritePolicy({
      projectDirs: ["/work/alpha"],
      sessionDir: "/tmp/s1",
    });

    // 不放行这些，隔离会把正常构建变成一堆只读错误。
    expect(roots.some((root) => root.includes("Cache"))).toBeTruthy();
    expect(roots).toContain("/tmp");
  });

  test("should deduplicate and skip empty entries", () => {
    const roots = buildWritePolicy({
      projectDirs: ["/work/alpha", "/work/alpha"],
      sessionDir: "/work/alpha",
    });

    expect(roots.filter((root) => root === "/work/alpha")).toHaveLength(1);
    expect(roots.every((root) => root.length > 0)).toBeTruthy();
  });

  test("should append extra roots and homeDir while excluding readOnlyDirs", () => {
    const roots = buildWritePolicy({
      projectDirs: ["/work/alpha"],
      sessionDir: "/tmp/s1",
      extra: ["/work/cache"],
      homeDir: "/work/bot-home",
    });

    expect(roots).toContain("/work/cache");
    expect(roots).toContain("/work/bot-home");
  });
});

describe(isWritablePath, () => {
  const roots = ["/work/alpha", "/tmp"];

  test("should accept the root and its descendants", () => {
    expect(isWritablePath("/work/alpha", roots)).toBeTruthy();
    expect(isWritablePath("/work/alpha/src/a.ts", roots)).toBeTruthy();
  });

  test("should reject a sibling that shares a prefix", () => {
    // 前缀字符串比较会把 `/work/alpha-sibling` 放行，逐段比较不会。
    expect(isWritablePath("/work/alpha-sibling/a.ts", roots)).toBeFalsy();
    expect(isWritablePath("/work", roots)).toBeFalsy();
  });
});

describe(buildSeatbeltProfile, () => {
  test("should deny every write before allowing the roots", () => {
    const profile = buildSeatbeltProfile(["/work/alpha"]);

    expect(profile).toContain("(version 1)");
    expect(profile).toContain("(allow default)");
    expect(profile).toContain("(deny file-write*)");
    expect(profile).toContain('(subpath "/work/alpha")');
  });

  test("should keep the device nodes writable", () => {
    const profile = buildSeatbeltProfile(["/work/alpha"]);

    // 写入被整体关掉之后必须还回设备节点，否则重定向全失败。
    expect(profile).toContain('(literal "/dev/null")');
    expect(profile).toContain('(regex #"^/dev/fd/")');
  });

  test("should escape quotes and backslashes in a path", () => {
    const profile = buildSeatbeltProfile(['/work/a"b\\c']);

    expect(profile).toContain('(subpath "/work/a\\"b\\\\c")');
  });
});

describe(buildSeatbeltInvocation, () => {
  test("should wrap the shell argv in sandbox-exec", () => {
    const invocation = buildSeatbeltInvocation(
      ["/work/alpha"],
      ["/bin/bash", "-c", "echo hi"]
    );

    expect(invocation.file).toBe(SEATBELT_BINARY);
    expect(invocation.args[0]).toBe("-p");
    expect(invocation.args[1]).toContain("(deny file-write*)");
    expect(invocation.args.slice(2)).toStrictEqual([
      "/bin/bash",
      "-c",
      "echo hi",
    ]);
  });
});

describe(buildBwrapInvocation, () => {
  test("should mount the root read-only and bind each writable root", () => {
    const invocation = buildBwrapInvocation(["/work/alpha"], "/work/alpha", [
      "/bin/bash",
      "-c",
      "echo hi",
    ]);

    expect(invocation.file).toBe("bwrap");
    expect(invocation.args.slice(0, 3)).toStrictEqual(["--ro-bind", "/", "/"]);
    expect(invocation.args).toContain("--dev");
    expect(
      invocation.args.slice(0, invocation.args.indexOf("--chdir"))
    ).toContain("/work/alpha");
    expect(invocation.args.slice(-3)).toStrictEqual([
      "/bin/bash",
      "-c",
      "echo hi",
    ]);
  });

  test("should not mount a fresh procfs", () => {
    const invocation = buildBwrapInvocation(["/work/alpha"], "/work/alpha", [
      "/bin/true",
    ]);

    // 新挂 procfs 要 pid 命名空间，否则内核拒绝，整条命令以退出码 1 收场；
    // 读本来就不受限，宿主的 `/proc` 跟着只读挂载进来就够用。
    expect(invocation.args).not.toContain("--proc");
  });

  test("should tolerate a writable root that does not exist", () => {
    const missing = "/work/not-created-yet";
    const invocation = buildBwrapInvocation([missing], "/work", ["/bin/true"]);
    const at = invocation.args.indexOf("--bind-try");

    // `--bind` 会让整条命令因为一个不存在的缓存目录而失败。
    expect(invocation.args).not.toContain("--bind");
    expect(invocation.args.slice(at, at + 3)).toStrictEqual([
      "--bind-try",
      missing,
      missing,
    ]);
  });
});

describe(detectBackend, () => {
  test("should pick the platform's native mechanism", () => {
    const expected =
      process.platform === "darwin"
        ? "seatbelt"
        : process.platform === "linux"
          ? "bwrap"
          : undefined;

    expect(detectBackend()).toBe(expected);
  });
});

// 探针结果决定后面跑真实用例还是跳过；`sandbox-exec` 在部分环境里存在但
// `sandbox_apply` 会被外层策略拒绝，所以这里必须是实测。
const probe = await probeNativeIsolation();

// 跳过不是「没有这条用例」：把原因打出来，否则没人分得清是平台不支持还是策略
// 没生效。`vp test` 会原样打印这一行。
if (!probe.available) {
  console.info(`[sandbox] native isolation is unavailable: ${probe.reason}`);
}

describe(probeNativeIsolation, () => {
  test("should report a backend or a reason", () => {
    // 可用时给机制名，不可用时给原因；两者总要有一个。
    const detail = probe.available ? probe.backend : probe.reason;

    expect((detail ?? "").length).toBeGreaterThan(0);
  });
});

describe("isolated adapter", () => {
  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
    );
  });

  test(
    "should refuse to acquire when isolation is unavailable",
    { skip: probe.available },
    async () => {
      await expect(
        createIsolatedSandboxAdapter().acquire({
          id: "s1",
          projectDirs: [tmpdir()],
          sessionDir: tmpdir(),
        })
      ).rejects.toThrow("Native isolation is unavailable");
    }
  );

  test(
    "should deny a file write outside the project directory",
    { skip: !probe.available },
    async () => {
      const project = await createTempDir();
      const { sandbox } = await createIsolatedSandboxAdapter().acquire({
        id: "s1",
        projectDirs: [project],
        sessionDir: project,
      });

      await sandbox.writeFile(join(project, "inside.txt"), "hello");

      const outside = join(homedir(), `.aify-write-probe-${process.pid}`);
      await expectPathDenied(sandbox.writeFile(outside, "nope"), "writeFile");
      await expectPathDenied(sandbox.mkdir(outside), "mkdir");
      await expectPathDenied(sandbox.rm(outside), "rm");
    }
  );

  test(
    "should allow deleting a symlink but not writing through it",
    { skip: !probe.available },
    async () => {
      const project = await createTempDir();
      const target = join(homedir(), `.aify-link-target-${process.pid}`);
      await writeFile(target, "outside");
      const link = join(project, "link.txt");
      await symlink(target, link);

      const { sandbox } = await createIsolatedSandboxAdapter().acquire({
        id: "s1",
        projectDirs: [project],
        sessionDir: project,
      });

      try {
        // 写会跟随链接，必须被拦；删只动目录项，必须放行。
        await expectPathDenied(sandbox.writeFile(link, "nope"), "writeFile");
        await sandbox.rm(link);
      } finally {
        await rm(target, { force: true });
      }
    }
  );

  test(
    "should confine writes to the project directory",
    { skip: !probe.available },
    async () => {
      const project = await createTempDir();
      const { sandbox } = await createIsolatedSandboxAdapter().acquire({
        id: "s1",
        projectDirs: [project],
        sessionDir: project,
      });

      const errors: string[] = [];
      const inside = await sandbox.exec("touch inside.txt", {
        cwd: project,
        onData: (channel, chunk) => {
          if (channel === "stderr") {
            errors.push(chunk.toString());
          }
        },
      });
      // 命令起不来时退出码是 1，原因只在 stderr 里：失败时把它一起报出来。
      if (inside.exitCode !== 0) {
        throw new Error(
          `touch in a writable root exited with ${String(inside.exitCode)}: ${errors.join("").trim()}`
        );
      }

      // 家目录不在可写根里：临时目录本来就是可写根，不能拿它当"外面"。
      const outside = join(homedir(), `.aify-sandbox-probe-${process.pid}`);
      try {
        const denied = await sandbox.exec(`touch "${outside}"`, {
          cwd: project,
        });
        expect(denied.exitCode).not.toBe(0);
      } finally {
        await rm(outside, { force: true });
      }
    }
  );

  test(
    "should allow reading readOnlyDirs, deny writing them, and apply homeDir and env",
    { skip: !probe.available },
    async () => {
      const project = await createTempDir();
      // Place skillsDir outside $TMPDIR because buildWritePolicy allows $TMPDIR for build tools.
      const skillsDir = await mkdtemp(join(homedir(), ".aify-sbx-ro-"));
      tempDirs.push(skillsDir);
      const botHome = await createTempDir();
      const skillFile = join(skillsDir, "SKILL.md");
      await writeFile(skillFile, "# skill", "utf-8");

      const { sandbox } = await createIsolatedSandboxAdapter().acquire({
        id: "s-bot",
        projectDirs: [project],
        sessionDir: project,
        readOnlyDirs: [skillsDir],
        homeDir: botHome,
        env: { BOT_ENV_TEST: "from-bot" },
      });

      await expect(sandbox.readFile(skillFile)).resolves.toBe("# skill");
      await expectPathDenied(
        sandbox.writeFile(join(skillsDir, "hack.txt"), "nope"),
        "writeFile"
      );
      await expectPathDenied(sandbox.mkdir(join(skillsDir, "sub")), "mkdir");
      await expectPathDenied(sandbox.rm(skillFile), "rm");

      expect(sandbox.resolvePath("~/data.txt")).toBe(join(botHome, "data.txt"));
      await sandbox.writeFile("~/data.txt", "ok");
      await expect(sandbox.readFile(join(botHome, "data.txt"))).resolves.toBe(
        "ok"
      );

      const stdout: string[] = [];
      const res = await sandbox.exec('printf "%s|%s" "$BOT_ENV_TEST" "$HOME"', {
        onData: (channel, chunk) => {
          if (channel === "stdout") {
            stdout.push(chunk.toString("utf-8"));
          }
        },
      });
      expect(res.exitCode).toBe(0);
      expect(stdout.join("")).toBe(`from-bot|${botHome}`);
    }
  );
});

if (probe.available) {
  const project = await mkdtemp(join(tmpdir(), "aify-sbx-contract-"));
  tempDirs.push(project);
  await writeFile(join(project, "seed.txt"), "hello\n", "utf-8");

  describeSandboxContract({
    name: "isolated",
    create: async () => {
      const handle = await createIsolatedSandboxAdapter().acquire({
        id: "contract",
        projectDirs: [project],
        sessionDir: project,
      });
      return handle.sandbox;
    },
  });
}
