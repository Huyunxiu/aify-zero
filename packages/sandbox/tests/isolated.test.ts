import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  SEATBELT_BINARY,
  buildBwrapInvocation,
  buildSeatbeltInvocation,
  buildSeatbeltProfile,
  buildWritePolicy,
  createIsolatedSandboxAdapter,
  isWritablePath,
  detectBackend,
  probeNativeIsolation,
} from "../src/index";
import { describeSandboxContract } from "../src/testing/contract";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "aify-sbx-isolated-"));
  tempDirs.push(dir);
  return dir;
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

  test("should append extra roots", () => {
    const roots = buildWritePolicy({
      projectDirs: ["/work/alpha"],
      sessionDir: "/tmp/s1",
      extra: ["/work/cache"],
    });

    expect(roots).toContain("/work/cache");
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
    // 可用时给后端名，不可用时给原因；两者总要有一个。
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
      await expect(sandbox.writeFile(outside, "nope")).rejects.toThrow(
        "outside the sandbox's writable roots"
      );
      await expect(sandbox.mkdir(outside)).rejects.toThrow(
        "outside the sandbox's writable roots"
      );
      await expect(sandbox.rm(outside)).rejects.toThrow(
        "outside the sandbox's writable roots"
      );
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
        await expect(sandbox.writeFile(link, "nope")).rejects.toThrow(
          "outside the sandbox's writable roots"
        );
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

      const inside = await sandbox.exec("touch inside.txt", { cwd: project });
      expect(inside.exitCode).toBe(0);

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
