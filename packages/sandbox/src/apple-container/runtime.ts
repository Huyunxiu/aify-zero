/**
 * Apple `container` CLI 的调用接缝。
 *
 * 这里只做一件事：把 CLI 当成一个可以替换的对象。真实现按子进程调用，测试给
 * 一份假实现，于是适配器的逻辑（挂载集、越界判断、生命周期）在不装 CLI 的机器上
 * 也能跑。
 */
import { homedir } from "node:os";

import { runShell } from "../exec";
import type { ExecResult } from "../types";

/** 适配器的名字；也是 `AIFY_SANDBOX_ADAPTER` 的一个取值。 */
export const APPLE_CONTAINER_ADAPTER = "apple-container";

/** `container` 默认在 PATH 上；允许覆盖成绝对路径，便于测试和特殊的安装位置。 */
export const DEFAULT_CONTAINER_BINARY = "container";

/** 探针的超时：只问版本号，不需要更多。 */
const PROBE_TIMEOUT_MS = 10_000;

/** 起容器的超时：第一次会拉镜像。 */
const START_TIMEOUT_MS = 15 * 60_000;

/** 起完容器之后等它能执行命令的窗口。 */
const READY_TIMEOUT_MS = 30_000;

/** 单条 `container exec` 探活的上限。 */
const READY_EXEC_TIMEOUT_MS = 5000;

export interface ContainerProbeResult {
  readonly available: boolean;
  /** 直接给用户看的不可用原因。 */
  readonly reason?: string;
  /** `container --version` 的第一行。 */
  readonly version?: string;
}

export interface ContainerMount {
  /** 宿主路径；容器里挂到同一个绝对路径（ADR-0007）。 */
  readonly hostPath: string;
  readonly containerPath: string;
}

export interface ContainerSpec {
  readonly name: string;
  readonly image: string;
  /** 容器里的默认工作目录。 */
  readonly workdir: string;
  readonly mounts: readonly ContainerMount[];
  readonly env?: NodeJS.ProcessEnv;
  /** 容器起来之后跑的保活命令。 */
  readonly command: readonly string[];
}

export interface ContainerCommandOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly onData?: (channel: "stdout" | "stderr", chunk: Buffer) => void;
}

export interface ContainerRuntime {
  /** 这台机器现在能不能用 Apple 容器。 */
  probe(): Promise<ContainerProbeResult>;
  /** 起一个长驻容器；失败就抛。 */
  start(spec: ContainerSpec): Promise<void>;
  /** 在容器里跑一条命令。`argv` 已经是容器里要执行的完整命令行。 */
  exec(
    name: string,
    argv: readonly string[],
    options?: ContainerCommandOptions
  ): Promise<ExecResult>;
  /** 容器现在能不能执行命令。 */
  ready(name: string): Promise<boolean>;
  /** 停掉并删除容器；不存在也算成功。 */
  destroy(name: string): Promise<void>;
}

export interface AppleContainerRuntimeOptions {
  readonly binary?: string;
}

/** 一次 CLI 调用的结果：结局之外还要输出，版本号和错误信息都在里面。 */
interface CliResult {
  readonly result: ExecResult;
  readonly stdout: Buffer;
  readonly stderr: string;
}

/**
 * 建一个真的按子进程调用 `container` 的运行时。
 *
 * 命令用 `container exec` 跑，所以 CLI 进程本身就是取消和超时的把手：杀掉它，
 * 容器里的命令不一定跟着停。适配器对超时改用容器里的 `timeout`，对这个差别做了
 * 处理；见 `adapter.ts`。
 */
export function createAppleContainerRuntime(
  options: AppleContainerRuntimeOptions = {}
): ContainerRuntime {
  const binary = options.binary ?? DEFAULT_CONTAINER_BINARY;
  // CLI 本身要在宿主上跑，给一个一定存在的目录，避免 cwd 已被删掉。
  const cliCwd = homedir();

  async function cli(
    args: readonly string[],
    commandOptions: ContainerCommandOptions = {}
  ): Promise<CliResult> {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    const result = await runShell({
      file: binary,
      args: [...args],
      cwd: cliCwd,
      env: { ...process.env },
      ...(commandOptions.timeoutMs === undefined
        ? {}
        : { timeoutMs: commandOptions.timeoutMs }),
      ...(commandOptions.signal === undefined
        ? {}
        : { signal: commandOptions.signal }),
      onData: (channel, chunk) => {
        if (channel === "stdout") {
          stdout.push(chunk);
        } else {
          stderr.push(chunk);
        }
        commandOptions.onData?.(channel, chunk);
      },
    });

    return {
      result: {
        exitCode: result.exitCode,
        signal: result.signal,
        timedOut: result.timedOut,
        aborted: result.aborted,
        durationMs: result.durationMs,
      },
      stdout: Buffer.concat(stdout),
      stderr: Buffer.concat(stderr).toString("utf-8"),
    };
  }

  return {
    probe: async (): Promise<ContainerProbeResult> => {
      if (process.platform !== "darwin") {
        return {
          available: false,
          reason: `apple-container is only available on macOS, not on ${process.platform}`,
        };
      }

      try {
        const { result, stdout, stderr } = await cli(["--version"], {
          timeoutMs: PROBE_TIMEOUT_MS,
        });
        if (result.exitCode !== 0) {
          return {
            available: false,
            reason: `the container CLI exited with ${result.exitCode ?? "no code"}: ${stderr.trim()}`,
          };
        }
        const version = stdout.toString("utf-8").split("\n")[0]?.trim();
        return {
          available: true,
          ...(version === undefined || version.length === 0 ? {} : { version }),
        };
      } catch (error) {
        return {
          available: false,
          reason: `the container CLI is not runnable: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },

    start: async (spec: ContainerSpec): Promise<void> => {
      const args = [
        "run",
        // 短选项与 Apple CLI 文档一致；`container run` 是唯一有 `-d` 的地方。
        "-d",
        "--name",
        spec.name,
        "--workdir",
        spec.workdir,
      ];

      for (const [key, value] of Object.entries(spec.env ?? {})) {
        if (value !== undefined) {
          args.push("--env", `${key}=${value}`);
        }
      }
      for (const mount of spec.mounts) {
        args.push("--volume", `${mount.hostPath}:${mount.containerPath}`);
      }
      args.push(spec.image, ...spec.command);

      const { result, stderr } = await cli(args, {
        timeoutMs: START_TIMEOUT_MS,
      });
      if (result.exitCode !== 0) {
        throw new Error(
          `could not start Apple container ${spec.name} from ${spec.image} (exit code ${result.exitCode ?? "null"}): ${stderr.trim()}`
        );
      }

      await waitUntilReady(spec.name);
    },

    exec: async (
      name: string,
      argv: readonly string[],
      commandOptions: ContainerCommandOptions = {}
    ): Promise<ExecResult> => {
      const { result } = await cli(["exec", name, ...argv], commandOptions);
      return result;
    },

    ready: async (name: string): Promise<boolean> => {
      try {
        const { result } = await cli(["exec", name, "true"], {
          timeoutMs: READY_EXEC_TIMEOUT_MS,
        });
        return result.exitCode === 0;
      } catch {
        return false;
      }
    },

    destroy: async (name: string): Promise<void> => {
      try {
        // 不存在也算成功：这个动词的语义是「之后没有这个容器」。
        await cli(["delete", "--force", name], {
          timeoutMs: READY_EXEC_TIMEOUT_MS,
        });
      } catch {
        // 清理失败不该盖住调用方正在处理的错误。
      }
    },
  };

  /**
   * 起完容器之后要等 `exec` 真的能跑。
   *
   * `container run` 返回时容器可能还没进到能执行命令的状态，直接跑第一条命令会
   * 偶发失败，而且看起来像工具坏了。
   */
  async function waitUntilReady(name: string): Promise<void> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const { result } = await cli(["exec", name, "true"], {
        timeoutMs: READY_EXEC_TIMEOUT_MS,
      });
      if (result.exitCode === 0) {
        return;
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 200);
      });
    }
    throw new Error(
      `Apple container ${name} did not become ready for exec within ${READY_TIMEOUT_MS} ms`
    );
  }
}
