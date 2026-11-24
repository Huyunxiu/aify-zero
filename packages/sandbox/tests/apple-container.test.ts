import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { buildExecArgv } from "../src/apple-container/adapter";
import { buildStartArgs } from "../src/apple-container/runtime";
import type {
  ContainerCommandOptions,
  ContainerRuntime,
  ContainerSpec,
} from "../src/apple-container/runtime";
import { runShell } from "../src/exec";
import {
  APPLE_CONTAINER_ADAPTER,
  SandboxPathDeniedError,
  createAppleContainerSandboxAdapter,
  createAppleContainerRuntime,
} from "../src/index";
import { describeSandboxContract } from "../src/testing/contract";
import type { AcquireSandboxInput, ExecResult, Sandbox } from "../src/types";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "aify-sbx-container-"));
  tempDirs.push(dir);
  return dir;
}

async function createInput(): Promise<AcquireSandboxInput> {
  const project = await createTempDir();
  const session = await createTempDir();
  return { id: "session-1", projectDirs: [project], sessionDir: session };
}

/**
 * 假容器：不碰 Apple 的 CLI，把 `exec` 的 argv 直接在宿主上跑。
 *
 * 这样契约测试在没有 `container` 的机器上也能跑，而且跑的是真的 shell——覆盖
 * 的是「argv 拼得对不对」，不是「CLI 有没有装」。
 */
interface HostRuntime extends ContainerRuntime {
  readonly started: ContainerSpec[];
  readonly execArgv: (readonly string[])[];
  readonly destroyed: string[];
  readonly running: Set<string>;
}

function createHostRuntime(
  options: { probeAvailable?: boolean } = {}
): HostRuntime {
  const started: ContainerSpec[] = [];
  const execArgv: (readonly string[])[] = [];
  const destroyed: string[] = [];
  const running = new Set<string>();

  return {
    started,
    execArgv,
    destroyed,
    running,
    probe: () =>
      Promise.resolve(
        options.probeAvailable === false
          ? { available: false, reason: "the container CLI is not installed" }
          : { available: true, version: "container 0.4.0 (fake)" }
      ),

    start: (spec: ContainerSpec) => {
      started.push(spec);
      running.add(spec.name);
      return Promise.resolve();
    },

    exec: async (
      name: string,
      argv: readonly string[],
      commandOptions: ContainerCommandOptions = {}
    ): Promise<ExecResult> => {
      execArgv.push(argv);
      if (!running.has(name)) {
        throw new Error(`container ${name} is not running`);
      }
      const [file, ...rest] = argv;
      if (file === undefined) {
        throw new Error("the container exec needs argv");
      }
      const result = await runShell({
        file,
        args: rest,
        cwd: process.cwd(),
        env: { ...process.env },
        ...(commandOptions.timeoutMs === undefined
          ? {}
          : { timeoutMs: commandOptions.timeoutMs }),
        ...(commandOptions.signal === undefined
          ? {}
          : { signal: commandOptions.signal }),
        onData: (channel, chunk) => {
          commandOptions.onData?.(channel, chunk);
        },
      });
      return {
        exitCode: result.exitCode,
        signal: result.signal,
        timedOut: result.timedOut,
        aborted: result.aborted,
        durationMs: result.durationMs,
      };
    },

    ready: (name: string) => Promise.resolve(running.has(name)),

    destroy: (name: string) => {
      destroyed.push(name);
      running.delete(name);
      return Promise.resolve();
    },
  };
}

/** 只回一个固定结局的运行时，用来断言 argv 和字段映射。 */
function createStubRuntime(result: ExecResult): ContainerRuntime & {
  readonly execArgv: string[];
} {
  const execArgv: string[] = [];
  return {
    execArgv,
    probe: () => Promise.resolve({ available: true, version: "stub" }),
    start: () => Promise.resolve(),
    exec: (_name, argv) => {
      execArgv.push(...argv);
      return Promise.resolve(result);
    },
    ready: () => Promise.resolve(true),
    destroy: () => Promise.resolve(),
  };
}

/** 取第一项；测试里数组该有几项是断言的一部分，空了就是写错了。 */
function first<T>(items: readonly T[]): T {
  const [item] = items;
  if (item === undefined) {
    throw new Error("the test expected at least one item");
  }
  return item;
}

/** 输入里保证有的第一项项目目录。 */
function firstProject(input: AcquireSandboxInput): string {
  const [project] = input.projectDirs;
  if (project === undefined) {
    throw new Error("the test input needs one project directory");
  }
  return project;
}

function sandboxFor(
  runtime: ContainerRuntime,
  input: AcquireSandboxInput
): Promise<Sandbox> {
  const adapter = createAppleContainerSandboxAdapter({ runtime });
  return adapter.acquire(input).then((handle) => handle.sandbox);
}

describe("apple container sandbox", () => {
  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map(async (dir) => {
        await rm(dir, { recursive: true, force: true });
      })
    );
  });

  describeSandboxContract({
    name: "apple-container",
    create: async () =>
      await sandboxFor(createHostRuntime(), await createInput()),
  });

  test("should describe the container and its mounted roots", async () => {
    const input = await createInput();
    const sandbox = await sandboxFor(createHostRuntime(), input);
    const description = sandbox.describe();

    expect(description.backend).toBe(APPLE_CONTAINER_ADAPTER);
    expect(description.cwd).toBe(firstProject(input));
    expect(description.roots).toContain(firstProject(input));
    expect(description.roots).toContain(input.sessionDir);
  });

  test("should tell the model which shell it has and that reads are limited", async () => {
    const sandbox = await sandboxFor(createHostRuntime(), await createInput());
    const description = sandbox.describe();

    expect(description.shells).toStrictEqual(["bash"]);
    // 读也受限制，模型要提前知道这件事。
    expect(description.note).toContain("only read and write");
  });

  test("should start a container that mounts every directory at its own path", async () => {
    const input = await createInput();
    const runtime = createHostRuntime();
    await sandboxFor(runtime, input);

    expect(runtime.started).toHaveLength(1);
    const spec = first(runtime.started);
    expect(spec.mounts).toStrictEqual([
      { hostPath: firstProject(input), containerPath: firstProject(input) },
      { hostPath: input.sessionDir, containerPath: input.sessionDir },
    ]);
    expect(spec.workdir).toBe(firstProject(input));
    expect(spec.command).toStrictEqual(["sleep", "infinity"]);
  });

  test("should refuse to acquire when the container CLI is unavailable", async () => {
    const runtime = createHostRuntime({ probeAvailable: false });
    const adapter = createAppleContainerSandboxAdapter({ runtime });

    await expect(adapter.acquire(await createInput())).rejects.toThrow(
      /Apple container is unavailable: the container CLI is not installed/
    );
    // 不可用就不许启动，也不许退回本机。
    expect(runtime.started).toHaveLength(0);
  });

  test("should reconnect to a running container named by physicalId", async () => {
    const input = await createInput();
    const runtime = createHostRuntime();
    runtime.running.add("aify-existing");
    const adapter = createAppleContainerSandboxAdapter({ runtime });

    const handle = await adapter.acquire({
      ...input,
      physicalId: "aify-existing",
    });

    expect(handle.physicalId).toBe("aify-existing");
    expect(runtime.started).toHaveLength(0);
  });

  test("should replace a container that physicalId no longer names", async () => {
    const input = await createInput();
    const runtime = createHostRuntime();
    const adapter = createAppleContainerSandboxAdapter({ runtime });

    const handle = await adapter.acquire({ ...input, physicalId: "aify-gone" });

    expect(handle.physicalId).toBe("aify-session-1");
    // 同名容器可能还占着名字，先删再起。
    expect(runtime.destroyed).toContain("aify-session-1");
    expect(runtime.started).toHaveLength(1);
  });

  test("should sanitize the container name and dispose the container", async () => {
    const input = await createInput();
    const runtime = createHostRuntime();
    const adapter = createAppleContainerSandboxAdapter({ runtime });
    const handle = await adapter.acquire({ ...input, id: "Session 1/A" });

    expect(handle.physicalId).toBe("aify-session-1-a");
    await handle.dispose?.();
    expect(runtime.destroyed).toContain("aify-session-1-a");
  });

  test("should deny reads outside the mounted directories", async () => {
    const input = await createInput();
    const sandbox = await sandboxFor(createHostRuntime(), input);

    await expect(sandbox.readFile("/etc/hosts")).rejects.toBeInstanceOf(
      SandboxPathDeniedError
    );
    await expect(sandbox.readFileBuffer("/etc/hosts")).rejects.toBeInstanceOf(
      SandboxPathDeniedError
    );
    await expect(sandbox.stat("/etc")).rejects.toBeInstanceOf(
      SandboxPathDeniedError
    );
    await expect(sandbox.readdir("/etc")).rejects.toBeInstanceOf(
      SandboxPathDeniedError
    );
    // `exists` 按契约不抛。
    await expect(sandbox.exists("/etc/hosts")).resolves.toBeFalsy();
  });

  test("should deny writes and deletes outside the mounted directories", async () => {
    const outside = await createTempDir();
    const sandbox = await sandboxFor(createHostRuntime(), await createInput());
    const target = join(outside, "outside.txt");

    await expect(sandbox.writeFile(target, "x")).rejects.toBeInstanceOf(
      SandboxPathDeniedError
    );
    await expect(
      sandbox.mkdir(outside, { recursive: true })
    ).rejects.toBeInstanceOf(SandboxPathDeniedError);
    await expect(
      sandbox.rm(outside, { recursive: true })
    ).rejects.toBeInstanceOf(SandboxPathDeniedError);
  });

  test("should deny a read that a symlink points outside", async () => {
    const input = await createInput();
    const outside = await createTempDir();
    const secret = join(outside, "secret.txt");
    await writeFile(secret, "secret");
    const link = join(firstProject(input), "escape.txt");
    await symlink(secret, link);

    const sandbox = await sandboxFor(createHostRuntime(), input);

    // 链接本身在挂载集里，但读会跟到外面去。
    await expect(sandbox.readFile(link)).rejects.toBeInstanceOf(
      SandboxPathDeniedError
    );
  });

  test("should keep the two paths inside the mounted directories working", async () => {
    const input = await createInput();
    const sandbox = await sandboxFor(createHostRuntime(), input);
    const project = join(firstProject(input), "note.txt");
    const session = join(input.sessionDir, "scratch.txt");

    await sandbox.writeFile(project, "project");
    await sandbox.writeFile(session, "session");

    await expect(sandbox.readFile(project)).resolves.toBe("project");
    await expect(sandbox.readFile(session)).resolves.toBe("session");
  });

  test("should run the command inside the container at the resolved cwd", async () => {
    const input = await createInput();
    const runtime = createHostRuntime();
    const sandbox = await sandboxFor(runtime, input);

    const result = await sandbox.exec("pwd");
    expect(result.exitCode).toBe(0);
    expect(runtime.execArgv).toHaveLength(1);
    const argv = first(runtime.execArgv);
    expect(argv).toContain(firstProject(input));
    expect(argv).toContain("bash");
    expect(argv).toContain("-c");
  });

  test("should refuse a shell the container does not have", async () => {
    const sandbox = await sandboxFor(createHostRuntime(), await createInput());
    await expect(
      sandbox.exec("Get-Location", { shell: "powershell" })
    ).rejects.toThrow(/only bash is available/);
  });

  test("should report a timeout the container's timeout command reported", async () => {
    const runtime = createStubRuntime({
      exitCode: 124,
      signal: null,
      timedOut: false,
      aborted: false,
      durationMs: 1,
    });
    const sandbox = await sandboxFor(runtime, await createInput());

    const result = await sandbox.exec("sleep 60", { timeoutMs: 1000 });
    expect(result.timedOut).toBeTruthy();
  });

  test("should pass an exit code of 124 through when there is no deadline", async () => {
    const runtime = createStubRuntime({
      exitCode: 124,
      signal: null,
      timedOut: false,
      aborted: false,
      durationMs: 1,
    });
    const sandbox = await sandboxFor(runtime, await createInput());

    // 没有截止时间时，124 只是命令自己的退出码。
    const result = await sandbox.exec("exit 124");
    expect(result.timedOut).toBeFalsy();
  });

  test("should mount readOnlyDirs as read-only and homeDir as writable", async () => {
    const input = await createInput();
    const skillsDir = await createTempDir();
    const botHome = await createTempDir();
    await writeFile(join(skillsDir, "SKILL.md"), "# skill", "utf-8");
    const runtime = createHostRuntime();

    const sandbox = await sandboxFor(runtime, {
      ...input,
      readOnlyDirs: [skillsDir],
      homeDir: botHome,
    });

    expect(first(runtime.started).mounts).toStrictEqual([
      { hostPath: firstProject(input), containerPath: firstProject(input) },
      { hostPath: input.sessionDir, containerPath: input.sessionDir },
      { hostPath: botHome, containerPath: botHome },
      { hostPath: skillsDir, containerPath: skillsDir, readOnly: true },
    ]);

    expect(sandbox.resolvePath("~/out.txt")).toBe(join(botHome, "out.txt"));
    await sandbox.writeFile("~/out.txt", "home-ok");
    await expect(sandbox.readFile(join(botHome, "out.txt"))).resolves.toBe(
      "home-ok"
    );
    await expect(sandbox.readFile(join(skillsDir, "SKILL.md"))).resolves.toBe(
      "# skill"
    );
    await expect(
      sandbox.writeFile(join(skillsDir, "mutate.txt"), "bad")
    ).rejects.toBeInstanceOf(SandboxPathDeniedError);
  });

  test("should reject mkdir and rm on readOnlyDirs and inject base env", async () => {
    const input = await createInput();
    const skillsDir = await createTempDir();
    const botHome = await createTempDir();
    await writeFile(join(skillsDir, "SKILL.md"), "# skill", "utf-8");
    const runtime = createHostRuntime();

    const sandbox = await sandboxFor(runtime, {
      ...input,
      readOnlyDirs: [skillsDir],
      homeDir: botHome,
      env: { BOT_TOKEN: "secret", OVERRIDE: "base" },
    });

    await expect(sandbox.mkdir(join(skillsDir, "sub"))).rejects.toBeInstanceOf(
      SandboxPathDeniedError
    );
    await expect(
      sandbox.rm(join(skillsDir, "SKILL.md"))
    ).rejects.toBeInstanceOf(SandboxPathDeniedError);

    const out: string[] = [];
    const execResult = await sandbox.exec(
      'printf "%s|%s|%s" "$BOT_TOKEN" "$OVERRIDE" "$HOME"',
      {
        env: { OVERRIDE: "call" },
        onData: (channel, chunk) => {
          if (channel === "stdout") {
            out.push(chunk.toString("utf-8"));
          }
        },
      }
    );
    expect(execResult.exitCode).toBe(0);
    expect(out.join("")).toBe(`secret|call|${botHome}`);
  });
});

describe(buildExecArgv, () => {
  test("should enter the cwd and pass the command as an argument", () => {
    const argv = buildExecArgv("echo hi", "/work/alpha", "bash");

    expect(argv[0]).toBe("sh");
    expect(argv).toContain('cd "$1" && shift && exec "$@"');
    expect(argv).toContain("/work/alpha");
    expect(argv.slice(-3)).toStrictEqual(["bash", "-c", "echo hi"]);
  });

  test("should wrap the command in timeout when a deadline is given", () => {
    const argv = buildExecArgv(
      "npm test",
      "/work/alpha",
      "bash",
      undefined,
      2500
    );
    const timeoutAt = argv.indexOf("timeout");

    expect(timeoutAt).toBeGreaterThan(-1);
    // 秒为单位，小数要保留，否则 2500ms 会被当成 2 秒。
    expect(argv.slice(timeoutAt, timeoutAt + 6)).toStrictEqual([
      "timeout",
      "-s",
      "TERM",
      "-k",
      "5s",
      "2.5s",
    ]);
    expect(argv.slice(-3)).toStrictEqual(["bash", "-c", "npm test"]);
  });

  test("should pass environment overrides via env", () => {
    const argv = buildExecArgv("env", "/work/alpha", "bash", { CI: "1" });

    expect(argv).toContain("env");
    expect(argv).toContain("CI=1");
  });

  test("should pass read-only mounts with --mount readonly in buildStartArgs", () => {
    const args = buildStartArgs({
      name: "aify-s1",
      image: "node:22",
      workdir: "/work/alpha",
      mounts: [
        { hostPath: "/work/alpha", containerPath: "/work/alpha" },
        {
          hostPath: "/bots/b1/skills",
          containerPath: "/bots/b1/skills",
          readOnly: true,
        },
      ],
      command: ["sleep", "infinity"],
    });

    expect(args).toContain("--volume");
    expect(args).toContain("/work/alpha:/work/alpha");
    expect(args).toContain("--mount");
    expect(args).toContain(
      "type=bind,source=/bots/b1/skills,target=/bots/b1/skills,readonly"
    );
  });
});

describe("apple container runtime", () => {
  test("should report why the CLI is unavailable instead of throwing", async () => {
    const runtime = createAppleContainerRuntime({
      binary: "aify-no-such-container",
    });
    const probe = await runtime.probe();

    expect(probe.available).toBeFalsy();
    expect(probe.reason?.length).toBeGreaterThan(0);
  });
});
