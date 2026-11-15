/**
 * 原生隔离适配器：本机适配器 + 平台自带的进程约束。
 *
 * 命令跑在 `sandbox-exec`（macOS seatbelt）或 `bwrap`（Linux bubblewrap）里，
 * 只能写进项目目录、会话目录、临时目录和常见构建缓存。文件动词仍直连本机
 * 文件系统——这是已知缺口：隔离约束的是命令派生的进程，不是 server 进程自己
 * 的 `node:fs` 调用。
 */
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

import { SandboxWriteDeniedError } from "../errors";
import { runShell } from "../exec";
import { createHostSandbox } from "../host/adapter";
import { defaultShellProgram, shellProgramArgv } from "../host/shell-program";
import { resolveSandboxPath } from "../paths";
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
} from "../types";
import {
  buildBwrapInvocation,
  buildSeatbeltInvocation,
  buildWritePolicy,
  detectBackend,
  isWritablePath,
} from "./policy";
import type { IsolationBackend } from "./policy";

/** 隔离适配器的名字；具体机制由 `describe().backend` 说明。 */
export const ISOLATED_ADAPTER = "isolated";

export interface IsolatedSandboxOptions {
  /** 额外可写根，追加到项目目录与会话目录之后。 */
  readonly extraWritableRoots?: readonly string[];
}

export interface IsolationProbeResult {
  readonly available: boolean;
  readonly backend?: IsolationBackend;
  /** 不可用的原因，直接给用户看。 */
  readonly reason?: string;
}

/** 探针的超时：只是起一个 `/usr/bin/true` 同级进程，不需要更多。 */
const PROBE_TIMEOUT_MS = 5000;

/**
 * 探测这台机器现在能不能真的套上原生隔离。
 *
 * 必须实测而不是只看二进制在不在：`sandbox-exec` 在部分环境里存在但
 * `sandbox_apply` 会被外层策略拒绝，只看文件存在会让每条命令都以
 * `Operation not permitted` 失败。
 */
export async function probeNativeIsolation(): Promise<IsolationProbeResult> {
  const backend = detectBackend();
  if (backend === undefined) {
    return {
      available: false,
      reason: `native isolation is not available on ${process.platform}`,
    };
  }

  const probe =
    backend === "seatbelt"
      ? {
          file: "/usr/bin/sandbox-exec",
          args: ["-p", "(version 1)(allow default)", "/usr/bin/true"],
        }
      : {
          file: "bwrap",
          args: ["--ro-bind", "/", "/", "--dev", "/dev", "--", "/bin/true"],
        };

  try {
    const result = await runShell({
      file: probe.file,
      args: probe.args,
      cwd: homedir(),
      env: { ...process.env },
      timeoutMs: PROBE_TIMEOUT_MS,
      onData: () => {
        // 探针的输出没有用处。
      },
    });

    if (result.exitCode === 0) {
      return { available: true, backend };
    }

    return {
      available: false,
      backend,
      reason: `${backend} refused to start a sandbox (exit code ${result.exitCode ?? "null"})`,
    };
  } catch (error) {
    return {
      available: false,
      backend,
      reason: `${backend} is not runnable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * 建一个原生隔离适配器。
 *
 * `acquire` 先探测；探测失败就抛，不退回无隔离的本机执行——用户以为隔离了、
 * 其实命令在本机裸跑，比直接失败危险得多。
 */
export function createIsolatedSandboxAdapter(
  options: IsolatedSandboxOptions = {}
): SandboxAdapter {
  return {
    name: ISOLATED_ADAPTER,
    acquire: async (input: AcquireSandboxInput): Promise<SandboxHandle> => {
      const probe = await probeNativeIsolation();
      if (probe.backend === undefined || !probe.available) {
        throw new Error(
          `Native isolation is unavailable: ${probe.reason ?? "unknown reason"}.`
        );
      }

      const host = createHostSandbox(input);
      const roots = buildWritePolicy({
        projectDirs: input.projectDirs,
        sessionDir: input.sessionDir,
        ...(options.extraWritableRoots === undefined
          ? {}
          : { extra: options.extraWritableRoots }),
      });

      return {
        sandbox: new IsolatedSandbox(host, probe.backend, roots),
      };
    },
  };
}

/** 包一层：命令走平台隔离，其余动词委托给本机适配器。 */
class IsolatedSandbox implements Sandbox {
  readonly #host: Sandbox;
  readonly #backend: IsolationBackend;
  readonly #roots: readonly string[];
  readonly #home: string;

  constructor(
    host: Sandbox,
    backend: IsolationBackend,
    roots: readonly string[]
  ) {
    this.#host = host;
    this.#backend = backend;
    this.#roots = roots;
    this.#home = homedir();
  }

  describe(): SandboxDescription {
    return {
      ...this.#host.describe(),
      backend: this.#backend,
      // 模型不该靠试错发现边界：写不出去的时候，它要知道原因和范围。
      note: "Writes are limited to the project directories, the session directory, temporary directories and build caches. Commands and file writes outside those paths fail.",
    };
  }

  async exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
    const cwd =
      options.cwd === undefined
        ? this.#host.describe().cwd
        : this.resolvePath(options.cwd);
    const program = shellProgramArgv(
      options.shell ?? defaultShellProgram(),
      command
    );
    const shellArgv = [program.file, ...program.args];
    const invocation =
      this.#backend === "seatbelt"
        ? buildSeatbeltInvocation(this.#roots, shellArgv)
        : buildBwrapInvocation(this.#roots, cwd, shellArgv);
    return await runShell({
      file: invocation.file,
      args: [...invocation.args],
      cwd,
      env: { ...process.env, ...options.env },
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      onData: (channel, chunk) => {
        options.onData?.(channel, chunk);
      },
    });
  }

  readFile(path: string): Promise<string> {
    return this.#host.readFile(path);
  }

  readFileBuffer(path: string): Promise<Uint8Array> {
    return this.#host.readFileBuffer(path);
  }

  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    // 写入会跟随最终符号链接，所以要检查链接指向哪里。
    const absolute = await this.#assertWritable("writeFile", path, true);
    await this.#host.writeFile(absolute, content);
  }

  stat(path: string): Promise<FileStat> {
    return this.#host.stat(path);
  }

  readdir(path: string): Promise<DirEntry[]> {
    return this.#host.readdir(path);
  }

  exists(path: string, options?: ExistsOptions): Promise<boolean> {
    return this.#host.exists(path, options);
  }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    // mkdir 不跟随最终链接：目标已是链接时系统会拒绝创建，这里只看目录项。
    const absolute = await this.#assertWritable("mkdir", path, false);
    await this.#host.mkdir(absolute, options);
  }

  async rm(
    path: string,
    options?: { recursive?: boolean; force?: boolean }
  ): Promise<void> {
    const absolute = await this.#assertWritable("rm", path, false);
    await this.#host.rm(absolute, options);
  }

  resolvePath(path: string): string {
    return resolveSandboxPath(path, {
      cwd: this.#host.describe().cwd,
      home: this.#home,
    });
  }

  async *readTextStream(path: string): AsyncIterable<string> {
    if (this.#host.readTextStream === undefined) {
      throw new Error("This sandbox cannot stream text.");
    }
    yield* this.#host.readTextStream(path);
  }

  async readHead(path: string, bytes: number): Promise<Uint8Array> {
    if (this.#host.readHead === undefined) {
      throw new Error("This sandbox cannot read a file head.");
    }
    return await this.#host.readHead(path, bytes);
  }

  /**
   * 写入前检查目标是否在可写根里，返回解析后的绝对路径。
   *
   * 先解析符号链接再判断：工作区里放一个指向外面的链接，就能让「写在工作区内」
   * 这个判断失效。
   */
  async #assertWritable(
    operation: string,
    path: string,
    followFinalLink: boolean
  ): Promise<string> {
    const absolute = this.resolvePath(path);
    const target = await resolveWriteTarget(absolute, followFinalLink);
    if (!isWritablePath(target, this.#roots)) {
      throw new SandboxWriteDeniedError({
        operation,
        path: absolute,
        roots: this.#roots,
      });
    }
    return absolute;
  }
}

/**
 * 目标路径的真实位置。
 *
 * 写入会跟随符号链接，所以 `followFinalLink` 为 true 时连最终链接一起解析——
 * 工作区里放一个指向外面的链接，不能让它把写入带到外面。删除只看目录项本身：
 * 删链接不会碰到链接的目标，链接指向外面也必须能删。
 */
async function resolveWriteTarget(
  absolute: string,
  followFinalLink: boolean
): Promise<string> {
  if (followFinalLink) {
    try {
      return await realpath(absolute);
    } catch {
      // 目标还不存在，走父目录那条路。
    }
  }

  const parent = await realpath(dirname(absolute)).catch(() =>
    dirname(absolute)
  );
  return join(parent, basename(absolute));
}
