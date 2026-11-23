/**
 * Apple 容器适配器：命令跑在 Linux 容器里，文件动词仍然直连宿主。
 *
 * 两侧的边界是同一个集合：挂载进容器的那些目录。命令被容器挡住，只能看见挂载集；
 * 文件动词在宿主上走 `node:fs`，所以必须自己按同一个集合校验——这就是它与
 * 原生隔离适配器的区别：那边挡写不挡读，这里读也一起挡。
 *
 * 文件动词不走 `container exec`（例如 `cat`）是有意的：同一份挂载在两侧字节相同，
 * 宿主读取快、不走 CLI、不留子进程；代价是容器镜像自己的文件系统对文件工具不可见，
 * 要读那些路径得用 `bash`。
 */
import { realpathSync } from "node:fs";
import { homedir } from "node:os";

import { SandboxPathDeniedError } from "../errors";
import { createHostSandbox } from "../host/adapter";
import { resolveSandboxPath } from "../paths";
import { isInsideRoots, resolveTargetPath } from "../roots";
import type {
  AcquireSandboxInput,
  DirEntry,
  ExecOptions,
  ExecResult,
  ExistsOptions,
  FileStat,
  Sandbox,
  SandboxAdapter,
  SandboxDescription,
  SandboxHandle,
  ShellKind,
} from "../types";
import {
  APPLE_CONTAINER_ADAPTER,
  createAppleContainerRuntime,
} from "./runtime";
import type { ContainerMount, ContainerRuntime } from "./runtime";

/** 默认镜像。要 git、bash 和 coreutils，所以不用 slim 变体。 */
export const DEFAULT_APPLE_CONTAINER_IMAGE = "node:22";

/** 容器里的保活命令：容器不自己退出，等 `container exec` 进来。 */
const KEEP_ALIVE_COMMAND = ["sleep", "infinity"] as const;

/** 容器能跑的方言。镜像里一定有 bash。 */
const CONTAINER_SHELLS: readonly ShellKind[] = ["bash"];

/** `timeout` 命令在超时之后发给内层进程的宽限。 */
const TIMEOUT_KILL_AFTER = "5s";

export interface AppleContainerOptions {
  /** 容器镜像。默认 `node:22`。 */
  readonly image?: string;
  /** 运行时接缝；测试注入假实现。 */
  readonly runtime?: ContainerRuntime;
  /** 额外挂进容器的宿主目录，按同一路径挂载。 */
  readonly extraMounts?: readonly string[];
  /** 容器名前缀。 */
  readonly namePrefix?: string;
}

/**
 * 建一个 Apple 容器适配器。
 *
 * `acquire` 先探测 CLI；不可用就抛，不退回本机——用户以为隔离了、其实命令在本机
 * 裸跑，比直接失败危险得多。
 */
export function createAppleContainerSandboxAdapter(
  options: AppleContainerOptions = {}
): SandboxAdapter {
  const runtime = options.runtime ?? createAppleContainerRuntime();
  const image = options.image ?? DEFAULT_APPLE_CONTAINER_IMAGE;
  const namePrefix = options.namePrefix ?? "aify";

  return {
    name: APPLE_CONTAINER_ADAPTER,
    acquire: async (input: AcquireSandboxInput): Promise<SandboxHandle> => {
      const probe = await runtime.probe();
      if (!probe.available) {
        throw new Error(
          `Apple container is unavailable: ${probe.reason ?? "unknown reason"}.`
        );
      }

      const mounts = collectMounts(input, options.extraMounts ?? []);
      const [firstMount] = mounts;
      if (firstMount === undefined) {
        throw new Error(
          "a container sandbox needs at least one mounted directory."
        );
      }
      const name = containerName(namePrefix, input.id);

      // 有 physicalId 就试着回到同一个容器：镜像和挂载都还在，省一次启动。
      if (
        input.physicalId !== undefined &&
        (await runtime.ready(input.physicalId))
      ) {
        return buildHandle(runtime, input, mounts, input.physicalId);
      }

      // 同名容器可能是上一次停掉留下的；`run --name` 会撞名字。
      await runtime.destroy(name);
      await runtime.start({
        name,
        image,
        workdir: firstMount.containerPath,
        mounts,
        command: KEEP_ALIVE_COMMAND,
      });

      return buildHandle(runtime, input, mounts, name);
    },
  };
}

function buildHandle(
  runtime: ContainerRuntime,
  input: AcquireSandboxInput,
  mounts: readonly ContainerMount[],
  name: string
): SandboxHandle {
  const sandbox = new AppleContainerSandbox(runtime, input, mounts, name);
  return {
    sandbox,
    physicalId: name,
    dispose: async () => {
      await runtime.destroy(name);
    },
  };
}

/**
 * 要挂进容器的目录：项目目录、会话目录，加上调用方额外指定的。
 *
 * 宿主路径就是容器路径（ADR-0007）：模型看到的绝对路径在两侧一致，工具的
 * 默认目录和 `describe().cwd` 不需要按环境改写。
 */
function collectMounts(
  input: AcquireSandboxInput,
  extraMounts: readonly string[]
): readonly ContainerMount[] {
  const seen = new Set<string>();
  const mounts: ContainerMount[] = [];
  const writableDirs = [
    ...input.projectDirs,
    input.sessionDir,
    ...(input.homeDir === undefined ? [] : [input.homeDir]),
    ...extraMounts,
  ];
  for (const path of writableDirs) {
    if (path.length === 0 || seen.has(path)) {
      continue;
    }
    seen.add(path);
    mounts.push({ hostPath: path, containerPath: path });
  }
  for (const path of input.readOnlyDirs ?? []) {
    if (path.length === 0 || seen.has(path)) {
      continue;
    }
    seen.add(path);
    mounts.push({ hostPath: path, containerPath: path, readOnly: true });
  }
  return mounts;
}

/** 容器名只能用字母数字和 `-_.`，会话 id 可能带别的字符。 */
function containerName(prefix: string, id: string): string {
  const safe = id.toLowerCase().replaceAll(/[^a-z0-9_.-]/gu, "-");
  return `${prefix}-${safe}`.slice(0, 63);
}

/** 容器里的一次执行：工作目录、环境变量、超时都摊成 argv。 */
export function buildExecArgv(
  command: string,
  cwd: string,
  shell: ShellKind,
  env?: NodeJS.ProcessEnv,
  timeoutMs?: number
): readonly string[] {
  const envArgs = Object.entries(env ?? {}).flatMap(([key, value]) =>
    value === undefined ? [] : [`${key}=${value}`]
  );
  const envPrefix = envArgs.length > 0 ? ["env", ...envArgs] : [];

  // 超时交给容器里的 `timeout`：只杀 CLI 进程的话，容器里的命令会继续跑，
  // 而工具已经告诉模型「超时了」。
  const timeoutArgs =
    timeoutMs === undefined
      ? []
      : [
          "timeout",
          "-s",
          "TERM",
          "-k",
          TIMEOUT_KILL_AFTER,
          `${Math.max(1, timeoutMs) / 1000}s`,
        ];

  // `$1` 是工作目录，`$@` 是剩下的 argv：路径和命令都当参数传，不经字符串拼接。
  return [
    "sh",
    "-lc",
    'cd "$1" && shift && exec "$@"',
    "aify-exec",
    cwd,
    ...envPrefix,
    ...timeoutArgs,
    shell,
    "-c",
    command,
  ];
}

/** 包一层：命令进容器，文件动词在宿主上按挂载集校验。 */
class AppleContainerSandbox implements Sandbox {
  readonly #runtime: ContainerRuntime;
  readonly #container: string;
  readonly #host: Sandbox;
  /** 挂载集，按原样：这是模型的视图，也是 `describe().roots`。 */
  readonly #mounts: readonly string[];
  /** 判断可读的根：挂载集加上它们的真实路径。 */
  readonly #readRoots: readonly string[];
  /** 判断可写的根：非只读挂载集加上它们的真实路径。 */
  readonly #writeRoots: readonly string[];
  readonly #cwd: string;
  readonly #home: string;
  readonly #baseEnv: NodeJS.ProcessEnv;

  constructor(
    runtime: ContainerRuntime,
    input: AcquireSandboxInput,
    mounts: readonly ContainerMount[],
    container: string
  ) {
    this.#runtime = runtime;
    this.#container = container;
    this.#host = createHostSandbox(input);
    this.#mounts = mounts.map((mount) => mount.containerPath);
    const writableMounts = mounts
      .filter((mount) => mount.readOnly !== true)
      .map((mount) => mount.containerPath);
    // 判断用两种形态：原样与解析符号链接之后。macOS 上 `TMPDIR` 是
    // `/var/…`，真实路径是 `/private/var/…`，只留一种会让合法路径被判越界。
    this.#readRoots = resolvedForms(this.#mounts);
    this.#writeRoots = resolvedForms(writableMounts);
    this.#cwd = this.#mounts[0] ?? input.sessionDir;
    this.#home = input.homeDir ?? homedir();
    this.#baseEnv = {
      ...input.env,
      ...(input.homeDir === undefined ? {} : { HOME: input.homeDir }),
    };
  }

  describe(): SandboxDescription {
    return {
      backend: APPLE_CONTAINER_ADAPTER,
      cwd: this.#cwd,
      roots: this.#mounts,
      shells: CONTAINER_SHELLS,
      // 模型不该靠试错发现边界：读不出去的时候，它要知道范围。
      note: "Commands run in a Linux container. The project directories and the session directory are mounted at the same absolute paths; no other host path is visible. File tools can only read and write paths inside those directories. Network access is available.",
    };
  }

  async exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
    const shell = options.shell ?? "bash";
    if (!CONTAINER_SHELLS.includes(shell)) {
      throw new Error(
        `The Apple container sandbox cannot run ${shell}: only bash is available.`
      );
    }

    const cwd =
      options.cwd === undefined ? this.#cwd : this.resolvePath(options.cwd);
    const mergedEnv: NodeJS.ProcessEnv = { ...this.#baseEnv, ...options.env };
    const env = Object.keys(mergedEnv).length > 0 ? mergedEnv : undefined;
    const argv = buildExecArgv(command, cwd, shell, env, options.timeoutMs);

    const result = await this.#runtime.exec(this.#container, argv, {
      ...(options.timeoutMs === undefined
        ? {}
        : { timeoutMs: options.timeoutMs }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      onData: (channel, chunk) => {
        options.onData?.(channel, chunk);
      },
    });

    // `timeout` 用 124 表示它自己超时。字段由我们补齐：CLI 进程是正常结束的，
    // 但容器里的命令确实被截止时间停掉了。
    const timedOut =
      result.timedOut ||
      (options.timeoutMs !== undefined && result.exitCode === 124);
    return timedOut === result.timedOut ? result : { ...result, timedOut };
  }

  async readFile(path: string): Promise<string> {
    const absolute = await this.#assertInside("readFile", path, true, "read");
    return await this.#host.readFile(absolute);
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    const absolute = await this.#assertInside(
      "readFileBuffer",
      path,
      true,
      "read"
    );
    return await this.#host.readFileBuffer(absolute);
  }

  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    const absolute = await this.#assertInside("writeFile", path, true, "write");
    await this.#host.writeFile(absolute, content);
  }

  async stat(path: string): Promise<FileStat> {
    const absolute = await this.#assertInside("stat", path, true, "read");
    return await this.#host.stat(absolute);
  }

  async readdir(path: string): Promise<DirEntry[]> {
    const absolute = await this.#assertInside("readdir", path, true, "read");
    return await this.#host.readdir(absolute);
  }

  async exists(path: string, options?: ExistsOptions): Promise<boolean> {
    // `exists` 按契约永不抛：越过边界就是「不存在」。
    const absolute = this.resolvePath(path);
    const target = await resolveTargetPath(absolute, true);
    const roots = options?.writable ? this.#writeRoots : this.#readRoots;
    if (!isInsideRoots(target, roots)) {
      return false;
    }
    return await this.#host.exists(absolute, options);
  }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    // mkdir 不跟随最终链接：目标已是链接时系统会拒绝创建，这里只看目录项。
    const absolute = await this.#assertInside("mkdir", path, false, "write");
    await this.#host.mkdir(absolute, options);
  }

  async rm(
    path: string,
    options?: { recursive?: boolean; force?: boolean }
  ): Promise<void> {
    const absolute = await this.#assertInside("rm", path, false, "write");
    await this.#host.rm(absolute, options);
  }

  resolvePath(path: string): string {
    return resolveSandboxPath(path, {
      cwd: this.#cwd,
      home: this.#home,
    });
  }

  async *readTextStream(path: string): AsyncIterable<string> {
    const absolute = await this.#assertInside(
      "readTextStream",
      path,
      true,
      "read"
    );
    if (this.#host.readTextStream === undefined) {
      throw new Error("This sandbox cannot stream text.");
    }
    yield* this.#host.readTextStream(absolute);
  }

  async readHead(path: string, bytes: number): Promise<Uint8Array> {
    const absolute = await this.#assertInside("readHead", path, true, "read");
    if (this.#host.readHead === undefined) {
      throw new Error("This sandbox cannot read a file head.");
    }
    return await this.#host.readHead(absolute, bytes);
  }

  /**
   * 越界就拒绝，返回解析后的绝对路径。
   *
   * 先解析符号链接再判断：工作区里放一个指向宿主其他地方的链接，就能让「读在
   * 挂载集里」这个判断失效。
   */
  async #assertInside(
    operation: string,
    path: string,
    followFinalLink: boolean,
    mode: "read" | "write"
  ): Promise<string> {
    const absolute = this.resolvePath(path);
    const target = await resolveTargetPath(absolute, followFinalLink);
    const roots = mode === "write" ? this.#writeRoots : this.#readRoots;
    if (!isInsideRoots(target, roots)) {
      throw new SandboxPathDeniedError({
        operation,
        path: absolute,
        roots,
      });
    }
    return absolute;
  }
}

/** 一组路径的原样与真实形态，去重。 */
function resolvedForms(paths: readonly string[]): readonly string[] {
  const forms = new Set<string>();
  for (const path of paths) {
    forms.add(path);
    try {
      forms.add(realpathSync(path));
    } catch {
      // 路径还不存在就只用原样形态。
    }
  }
  return [...forms];
}
