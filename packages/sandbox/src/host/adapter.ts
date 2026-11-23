/**
 * 本机适配器：把 server 进程所在的这台机器映射成沙箱。
 *
 * 它不提供隔离，只把当前的进程与文件系统能力包成统一的沙箱面。命令执行复用
 * agent 包里的进程内核（`../exec.ts`），文件动词直连 `node:fs/promises`，
 * 语义与旧工具逐条对齐。
 */
import { constants, createReadStream } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

import { runShell } from "../exec";
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
  ShellKind,
} from "../types";
import { defaultBashShell, defaultPowerShell } from "./resolve";
import { defaultShellProgram, shellProgramArgv } from "./shell-program";

/** 适配器名字，同时写进 `describe().backend`。 */
export const HOST_BACKEND = "host";

/**
 * 探测本机能跑的 shell 方言。
 *
 * 每次调用都重新问一次：可执行文件可能在进程启动后出现或消失，缓存一份结果
 * 会让 `describe()` 与 `exec()` 的判断不一致。
 */
function detectShells(): ShellKind[] {
  const shells: ShellKind[] = [];
  if (defaultBashShell() !== undefined) {
    shells.push("bash");
  }
  if (defaultPowerShell() !== undefined) {
    shells.push("powershell");
  }
  // `cmd` 只在 Windows 上存在，且没有对应工具；它让省略方言的内部命令有路可走。
  if (process.platform === "win32") {
    shells.push("cmd");
  }
  return shells;
}

/** 建一个本机沙箱适配器。适配器本身无状态，会话资源由宿主管理。 */
export function createHostSandboxAdapter(): SandboxAdapter {
  return {
    name: HOST_BACKEND,
    // 用 Promise 包住构造：缺少项目目录时抛的错要变成 rejection，而不是同步
    // 抛出，调用方才能统一用 await 处理。
    acquire: (input: AcquireSandboxInput): Promise<SandboxHandle> =>
      new Promise<SandboxHandle>((resolve) => {
        resolve({ sandbox: new HostSandbox(input) });
      }),
  };
}

/**
 * 直接建一个本机沙箱，不经过适配器的 Promise 外壳。
 *
 * 测试和不需要复用的调用方用它；需要按会话缓存实例的宿主用 `acquire`。
 */
export function createHostSandbox(input: AcquireSandboxInput): Sandbox {
  return new HostSandbox(input);
}

/** 一台本机上的沙箱。`id` 对它没有意义：同一台机器只有一个文件系统。 */
class HostSandbox implements Sandbox {
  readonly #cwd: string;
  readonly #roots: readonly string[];
  readonly #home: string;
  readonly #baseEnv: NodeJS.ProcessEnv;

  constructor(input: AcquireSandboxInput) {
    const [cwd] = input.projectDirs;
    if (cwd === undefined) {
      throw new Error("A sandbox needs at least one project directory.");
    }
    this.#cwd = cwd;
    const roots = new Set<string>();
    for (const dir of [
      ...input.projectDirs,
      input.sessionDir,
      ...(input.readOnlyDirs ?? []),
      ...(input.homeDir === undefined ? [] : [input.homeDir]),
    ]) {
      if (dir.length > 0) {
        roots.add(dir);
      }
    }
    this.#roots = [...roots];
    this.#home = input.homeDir ?? homedir();
    this.#baseEnv = {
      ...input.env,
      ...(input.homeDir === undefined ? {} : { HOME: input.homeDir }),
    };
  }

  describe(): SandboxDescription {
    return {
      backend: HOST_BACKEND,
      cwd: this.#cwd,
      roots: this.#roots,
      shells: detectShells(),
    };
  }

  async exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
    const { file, args } = shellProgramArgv(
      options.shell ?? defaultShellProgram(),
      command
    );

    // 本机适配器直接沿用进程环境；按白名单裁剪是后续适配器的事。
    return await runShell({
      file,
      args: [...args],
      cwd:
        options.cwd === undefined ? this.#cwd : this.resolvePath(options.cwd),
      env: { ...process.env, ...this.#baseEnv, ...options.env },
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      onData: (channel, chunk) => {
        options.onData?.(channel, chunk);
      },
    });
  }

  async readFile(path: string): Promise<string> {
    return await readFile(this.resolvePath(path), "utf-8");
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    // 复制一份，避免把 Buffer 的共享内存池交出去：调用方读 `.buffer` 时不该
    // 看到邻居文件的字节。
    return new Uint8Array(await readFile(this.resolvePath(path)));
  }

  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    const absolute = this.resolvePath(path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, content, "utf-8");
  }

  async stat(path: string): Promise<FileStat> {
    const absolute = this.resolvePath(path);
    const link = await lstat(absolute);
    if (!link.isSymbolicLink()) {
      return {
        isFile: link.isFile(),
        isDirectory: link.isDirectory(),
        isSymbolicLink: false,
        size: link.size,
        mtime: link.mtime,
      };
    }

    // 链接本身存在时不报错，真正关心的是目标；目标没了就只报链接这一层。
    try {
      const target = await stat(absolute);
      return {
        isFile: target.isFile(),
        isDirectory: target.isDirectory(),
        isSymbolicLink: true,
        size: target.size,
        mtime: target.mtime,
      };
    } catch {
      return { isFile: false, isDirectory: false, isSymbolicLink: true };
    }
  }

  async readdir(path: string): Promise<DirEntry[]> {
    const absolute = this.resolvePath(path);
    const dirents = await readdir(absolute, { withFileTypes: true });
    return await Promise.all(
      dirents.map(async (dirent): Promise<DirEntry> => {
        if (!dirent.isSymbolicLink()) {
          return {
            name: dirent.name,
            isFile: dirent.isFile(),
            isDirectory: dirent.isDirectory(),
            isSymbolicLink: false,
          };
        }

        try {
          const target = await stat(join(absolute, dirent.name));
          return {
            name: dirent.name,
            isFile: target.isFile(),
            isDirectory: target.isDirectory(),
            isSymbolicLink: true,
          };
        } catch {
          return {
            name: dirent.name,
            isFile: false,
            isDirectory: false,
            isSymbolicLink: true,
          };
        }
      })
    );
  }

  async exists(path: string, options: ExistsOptions = {}): Promise<boolean> {
    // F_OK 的值为 0，可以当作“不加约束”的底数。
    const readFlag =
      options.readable === true ? constants.R_OK : constants.F_OK;
    const writeFlag =
      options.writable === true ? constants.W_OK : constants.F_OK;
    try {
      await access(
        this.resolvePath(path),
        constants.F_OK | readFlag | writeFlag
      );
      return true;
    } catch {
      return false;
    }
  }

  async mkdir(
    path: string,
    options: { recursive?: boolean } = {}
  ): Promise<void> {
    await mkdir(this.resolvePath(path), {
      recursive: options.recursive === true,
    });
  }

  async rm(
    path: string,
    options: { recursive?: boolean; force?: boolean } = {}
  ): Promise<void> {
    await rm(this.resolvePath(path), {
      recursive: options.recursive === true,
      force: options.force === true,
    });
  }

  resolvePath(path: string): string {
    return resolveSandboxPath(path, { cwd: this.#cwd, home: this.#home });
  }

  /**
   * 按行流式读文本，避免大文件整份进内存。
   *
   * @param path - 文件路径，相对路径按沙箱 cwd 解析。
   * @yields 每一行的文本，不含行尾。
   */
  async *readTextStream(path: string): AsyncIterable<string> {
    const absolute = this.resolvePath(path);
    const stream = createReadStream(absolute, { encoding: "utf-8" });
    const lines = createInterface({
      crlfDelay: Number.POSITIVE_INFINITY,
      input: stream,
    });
    try {
      for await (const line of lines) {
        yield line;
      }
    } finally {
      lines.close();
      stream.destroy();
    }
  }

  async readHead(path: string, bytes: number): Promise<Uint8Array> {
    const absolute = this.resolvePath(path);
    const handle = await open(absolute, "r");
    try {
      const { size } = await handle.stat();
      const length = Math.max(0, Math.min(bytes, size));
      const buffer = new Uint8Array(length);
      if (length > 0) {
        await handle.read(buffer, 0, length, 0);
      }
      return buffer;
    } finally {
      await handle.close();
    }
  }
}
