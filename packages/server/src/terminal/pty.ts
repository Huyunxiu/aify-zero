/**
 * PTY 适配器：把 `@lydell/node-pty` 收成一个会话层能理解的小接口。
 *
 * 选 `@lydell/node-pty` 而不是微软的 `node-pty`，是因为它用平台可选依赖
 * 分发预编译二进制，没有 install 脚本，`spawn-helper` 也带可执行位。桌面和
 * 独立 server 只需要把对应的平台包一起带走。
 */
import * as nodePty from "@lydell/node-pty";

/** 事件订阅句柄；会话关闭时统一释放。 */
export interface TerminalSubscription {
  dispose(): void;
}

/** 一个已经启动的 PTY。 */
export interface TerminalPty {
  kill(): void;
  onData(listener: (data: Buffer) => void): TerminalSubscription;
  onExit(listener: (event: { exitCode: number }) => void): TerminalSubscription;
  pause(): void;
  resize(cols: number, rows: number): void;
  resume(): void;
  readonly pid: number;
  write(data: Uint8Array): void;
}

/** 启动 PTY 的参数。 */
export interface SpawnShellPtyOptions {
  /** 测试可以换一个非交互命令；默认按平台选登录 shell。 */
  readonly args?: readonly string[];
  readonly cols: number;
  readonly cwd: string;
  readonly rows: number;
  /** 测试可以指定 shell；默认取 `SHELL` 或平台默认值。 */
  readonly shell?: string;
}

/** 会话层注入的工厂；测试用它避开真实进程。 */
export type SpawnShellPty = (options: SpawnShellPtyOptions) => TerminalPty;

type NodePtyModule = typeof nodePty;

/**
 * `@lydell/node-pty` 是 CommonJS，ESM 构建和 CJS 构建对 default 的处理不同。
 * 统一取真正的模块对象，避免 `spawn` 在某种输出格式里变成 undefined。
 */
const ptyModule: NodePtyModule =
  (nodePty as { default?: NodePtyModule }).default ?? nodePty;

/**
 * 复制一份环境变量，过滤掉 undefined。
 *
 * PTY 子进程拿到的环境必须全是字符串；直接展开 `process.env` 会把
 * `string | undefined` 传下去。顺便补上 truecolor 声明，让 shell 和应用知道
 * 终端支持 24 位色。
 */
function cleanEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      environment[key] = value;
    }
  }

  environment.COLORTERM ??= "truecolor";
  environment.TERM = "xterm-256color";

  return environment;
}

/** 默认 shell：Windows 用 ComSpec / PowerShell，其他平台用登录 shell。 */
function defaultShell(): { args: string[]; file: string } {
  if (process.platform === "win32") {
    return { args: [], file: process.env.ComSpec ?? "powershell.exe" };
  }

  return {
    args: ["-l"],
    file:
      process.env.SHELL?.trim() ||
      (process.platform === "darwin" ? "/bin/zsh" : "/bin/sh"),
  };
}

/**
 * 启动一个 PTY。
 *
 * @param options - 尺寸、工作目录和测试注入项。
 * @returns 包住原生进程的会话接口。
 */
export const spawnShellPty: SpawnShellPty = ({
  args,
  cols,
  cwd,
  rows,
  shell,
}: SpawnShellPtyOptions): TerminalPty => {
  const defaults = defaultShell();
  const file = shell ?? defaults.file;
  const fileArgs = [...(args ?? defaults.args)];

  const processPty = ptyModule.spawn(file, fileArgs, {
    cols,
    cwd,
    encoding: null,
    env: cleanEnvironment(),
    name: "xterm-256color",
    rows,
  });

  return {
    kill(): void {
      try {
        processPty.kill();
      } catch {
        // 进程已经退出时 kill 会抛错；清理路径不需要再处理一次。
      }
    },
    onData(listener: (data: Buffer) => void): TerminalSubscription {
      const disposable = processPty.onData((chunk: string) => {
        // `encoding: null` 让底层返回 Buffer，但类型声明仍写成 string。
        const value: unknown = chunk;

        listener(
          Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf-8")
        );
      });

      return { dispose: () => disposable.dispose() };
    },
    onExit(
      listener: (event: { exitCode: number }) => void
    ): TerminalSubscription {
      const disposable = processPty.onExit(({ exitCode }) => {
        listener({ exitCode });
      });

      return { dispose: () => disposable.dispose() };
    },
    pause(): void {
      processPty.pause();
    },
    pid: processPty.pid,
    resize(nextCols: number, nextRows: number): void {
      processPty.resize(nextCols, nextRows);
    },
    resume(): void {
      processPty.resume();
    },
    write(data: Uint8Array): void {
      processPty.write(Buffer.from(data));
    },
  };
};
