/**
 * 内存沙箱。
 *
 * 它让工具测试不必碰真实文件系统，也证明工具只依赖 `Sandbox` 这个面：真适配器和
 * 假适配器能过同一份契约。
 */
import { posix } from "node:path";
import { fileURLToPath } from "node:url";

import { SandboxOperationUnsupportedError } from "../errors";
import type {
  DirEntry,
  ExecOptions,
  ExecResult,
  FileStat,
  Sandbox,
  SandboxAdapter,
  ShellKind,
} from "../types";

/** 假适配器的 home 目录。`~` 展开到这里，和真实适配器一样与平台无关。 */
const HOME = "/home/user";

/** 与 paths.ts 的处理一致：Unicode 空格先换成普通空格。 */
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

/** 一次被记录的 `exec` 调用。 */
export interface FakeExecCall {
  command: string;
  options?: ExecOptions;
}

/** 内存沙箱加上测试用的观察点。 */
export interface FakeSandbox extends Sandbox {
  /** 按发生顺序记录的 `exec` 调用。 */
  readonly calls: FakeExecCall[];
}

export interface FakeSandboxOptions {
  /** 相对路径的基准目录，默认 `/workspace`。 */
  readonly cwd?: string;
  /** 沙箱能碰到的根目录，默认 `[cwd]`。 */
  readonly roots?: readonly string[];
  /** 能跑的 shell 方言，默认 `["bash"]`；空数组表示只能读写文件。 */
  readonly shells?: readonly ShellKind[];
  /** 预置文件，键是路径。 */
  readonly files?: Record<string, string | Uint8Array>;
  /** 预置目录。 */
  readonly dirs?: readonly string[];
  /** 替换默认的 `exec` 行为。 */
  readonly exec?: (
    command: string,
    options: ExecOptions
  ) => ExecResult | Promise<ExecResult>;
  /** 为 true 时不定义 `readTextStream`，用来测调用方的退化路径。 */
  readonly withoutStreaming?: boolean;
  /** 为 true 时不定义 `readHead`，用来测调用方的退化路径。 */
  readonly withoutHead?: boolean;
}

/** 带 `code` 的文件系统错误；调用方常靠 `code` 分支。 */
interface CodedError extends Error {
  code: string;
}

function codedError(code: string, target: string): CodedError {
  const error = new Error(`${code}: ${target}`) as CodedError;
  error.code = code;
  return error;
}

/**
 * 把同步动词的异常转成 rejection。
 *
 * 沙箱动词一律返回 Promise：同一个动词，存在的路径 resolve、不存在的路径 reject，
 * 调用方不该看到「有时同步抛」的第三种形态。
 */
function asPromise<Value>(run: () => Value): Promise<Value> {
  try {
    return Promise.resolve(run());
  } catch (error) {
    return Promise.reject(
      error instanceof Error ? error : new Error(String(error))
    );
  }
}

/** 一个目录项是否直接位于 `parent` 下（`parent` 已归一化）。 */
function childPrefix(parent: string): string {
  return parent === "/" ? "/" : `${parent}/`;
}

export function createFakeSandbox(
  options: FakeSandboxOptions = {}
): FakeSandbox {
  const cwd = posix.resolve(options.cwd ?? "/workspace");
  const shells: readonly ShellKind[] = options.shells ?? ["bash"];
  const customExec = options.exec;
  const calls: FakeExecCall[] = [];

  const files = new Map<string, { bytes: Uint8Array; mtime: Date }>();
  const dirs = new Map<string, Date>([["/", new Date()]]);

  /**
   * 归一化模型给出的路径，规则与 paths.ts 的 `normalizeInputPath` 一致：
   * Unicode 空格、`@` 前缀、`~`、`file://`，最后按 `cwd` 解析并归一化。
   */
  function normalizeInputPath(filepath: string): string {
    let input = filepath.replace(UNICODE_SPACES, " ");
    if (input.startsWith("@")) {
      input = input.slice(1);
    }
    if (input === "~") {
      return HOME;
    }
    if (input.startsWith("~/") || input.startsWith("~\\")) {
      return posix.join(HOME, input.slice(2));
    }
    if (input.startsWith("file://")) {
      return fileURLToPath(input);
    }
    return input;
  }

  function resolvePath(filepath: string): string {
    const input = normalizeInputPath(filepath);
    return posix.normalize(
      posix.isAbsolute(input) ? input : posix.resolve(cwd, input)
    );
  }

  /** 建出 `target` 及其所有祖先；已存在的不动。 */
  function ensureDir(target: string): void {
    const normalized = posix.normalize(target);
    if (normalized === "/" || normalized === ".") {
      return;
    }
    let current = "";
    for (const part of normalized
      .split("/")
      .filter((segment) => segment !== "")) {
      current += `/${part}`;
      if (files.has(current)) {
        throw codedError("ENOTDIR", current);
      }
      if (!dirs.has(current)) {
        dirs.set(current, new Date());
      }
    }
  }

  function writeFileNow(filepath: string, content: string | Uint8Array): void {
    const target = resolvePath(filepath);
    if (dirs.has(target)) {
      throw codedError("EISDIR", target);
    }
    ensureDir(posix.dirname(target));
    const bytes =
      typeof content === "string"
        ? new TextEncoder().encode(content)
        : new Uint8Array(content);
    files.set(target, { bytes, mtime: new Date() });
  }

  function readFileBytesNow(filepath: string): Uint8Array {
    const target = resolvePath(filepath);
    const file = files.get(target);
    if (file === undefined) {
      throw dirs.has(target)
        ? codedError("EISDIR", target)
        : codedError("ENOENT", target);
    }
    return file.bytes;
  }

  function describe(): {
    backend: string;
    cwd: string;
    roots: readonly string[];
    shells: readonly ShellKind[];
  } {
    const roots = (options.roots ?? [cwd]).map((root) => resolvePath(root));
    return { backend: "fake", cwd, roots, shells: [...shells] };
  }

  async function exec(
    command: string,
    execOptions?: ExecOptions
  ): Promise<ExecResult> {
    if (shells.length === 0) {
      throw new SandboxOperationUnsupportedError({
        backend: "fake",
        operation: "exec",
        options: ["shell"],
      });
    }
    calls.push(
      execOptions === undefined
        ? { command }
        : { command, options: execOptions }
    );
    if (customExec !== undefined) {
      return await customExec(command, execOptions ?? {});
    }
    // 预取消优先：调用方看 `aborted` 字段，不靠异常。
    if (execOptions?.signal?.aborted === true) {
      return {
        aborted: true,
        durationMs: 0,
        exitCode: null,
        signal: null,
        timedOut: false,
      };
    }
    // 默认零退出码；只认 `exit N`，好让契约测试能断言非零退出码也是结果。
    const exitMatch = /^\s*exit\s+(\d+)\s*$/.exec(command);
    return {
      aborted: false,
      durationMs: 0,
      exitCode: exitMatch === null ? 0 : Number(exitMatch[1] ?? 0),
      signal: null,
      timedOut: false,
    };
  }

  function readFile(filepath: string): Promise<string> {
    return asPromise(() =>
      new TextDecoder("utf-8").decode(readFileBytesNow(filepath))
    );
  }

  function readFileBuffer(filepath: string): Promise<Uint8Array> {
    // 返回副本，调用方改动结果不会污染沙箱里的内容。
    return asPromise(() => new Uint8Array(readFileBytesNow(filepath)));
  }

  function writeFile(
    filepath: string,
    content: string | Uint8Array
  ): Promise<void> {
    return asPromise(() => writeFileNow(filepath, content));
  }

  async function* readTextStream(filepath: string): AsyncIterable<string> {
    const content = await readFile(filepath);
    const lines = content.split(/\r?\n/);
    // 结尾换行不产生空行；空文件不产生任何行。
    if (lines.at(-1) === "") {
      lines.pop();
    }
    yield* lines;
  }

  async function readHead(
    filepath: string,
    bytes: number
  ): Promise<Uint8Array> {
    const data = await readFileBuffer(filepath);
    return data.slice(0, Math.max(0, bytes));
  }

  function stat(filepath: string): Promise<FileStat> {
    const target = resolvePath(filepath);
    const file = files.get(target);
    if (file !== undefined) {
      // 拿得到的字段都给：类型、字节数、修改时间。
      return Promise.resolve({
        isDirectory: false,
        isFile: true,
        isSymbolicLink: false,
        mtime: file.mtime,
        size: file.bytes.byteLength,
      });
    }
    const directoryTime = dirs.get(target);
    if (directoryTime !== undefined) {
      // 目录的大小拿不到，按契约省略，不填占位值。
      return Promise.resolve({
        isDirectory: true,
        isFile: false,
        isSymbolicLink: false,
        mtime: directoryTime,
      });
    }
    return Promise.reject(codedError("ENOENT", target));
  }

  function readdir(filepath: string): Promise<DirEntry[]> {
    const target = resolvePath(filepath);
    if (!dirs.has(target)) {
      return Promise.reject(
        files.has(target)
          ? codedError("ENOTDIR", target)
          : codedError("ENOENT", target)
      );
    }
    const prefix = childPrefix(target);
    const entries: DirEntry[] = [];
    const add = (name: string, isDirectory: boolean): void => {
      // 只收直接子项；更深的后代由它们自己的父目录列出。
      if (name === "" || name.includes("/")) {
        return;
      }
      entries.push({
        isDirectory,
        isFile: !isDirectory,
        isSymbolicLink: false,
        name,
      });
    };
    for (const filePath of files.keys()) {
      if (filePath.startsWith(prefix)) {
        add(filePath.slice(prefix.length), false);
      }
    }
    for (const dirPath of dirs.keys()) {
      if (dirPath !== target && dirPath.startsWith(prefix)) {
        add(dirPath.slice(prefix.length), true);
      }
    }
    entries.sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0
    );
    return Promise.resolve(entries);
  }

  function exists(filepath: string): Promise<boolean> {
    // 这个动词永不抛：解析不了的路径也只是「不存在」。
    try {
      const target = resolvePath(filepath);
      return Promise.resolve(files.has(target) || dirs.has(target));
    } catch {
      return Promise.resolve(false);
    }
  }

  function mkdir(
    filepath: string,
    mkdirOptions: { recursive?: boolean } = {}
  ): Promise<void> {
    const target = resolvePath(filepath);
    if (dirs.has(target)) {
      return mkdirOptions.recursive === true
        ? Promise.resolve()
        : Promise.reject(codedError("EEXIST", target));
    }
    if (files.has(target)) {
      return Promise.reject(codedError("ENOTDIR", target));
    }
    if (mkdirOptions.recursive === true) {
      return asPromise(() => ensureDir(target));
    }
    if (!dirs.has(posix.dirname(target))) {
      return Promise.reject(codedError("ENOENT", target));
    }
    dirs.set(target, new Date());
    return Promise.resolve();
  }

  function rm(
    filepath: string,
    rmOptions: { recursive?: boolean; force?: boolean } = {}
  ): Promise<void> {
    const target = resolvePath(filepath);
    if (files.has(target)) {
      files.delete(target);
      return Promise.resolve();
    }
    if (dirs.has(target)) {
      const prefix = childPrefix(target);
      const descendantFiles = [...files.keys()].filter((path) =>
        path.startsWith(prefix)
      );
      const descendantDirs = [...dirs.keys()].filter((path) =>
        path.startsWith(prefix)
      );
      if (
        rmOptions.recursive !== true &&
        (descendantFiles.length > 0 || descendantDirs.length > 0)
      ) {
        return Promise.reject(codedError("ENOTEMPTY", target));
      }
      for (const path of descendantFiles) {
        files.delete(path);
      }
      for (const path of descendantDirs) {
        dirs.delete(path);
      }
      dirs.delete(target);
      return Promise.resolve();
    }
    return rmOptions.force === true
      ? Promise.resolve()
      : Promise.reject(codedError("ENOENT", target));
  }

  // 预置目录先建，预置文件再写；写文件本身会补出父目录。
  for (const dir of options.dirs ?? []) {
    ensureDir(resolvePath(dir));
  }
  for (const [path, content] of Object.entries(options.files ?? {})) {
    writeFileNow(path, content);
  }

  const sandbox: FakeSandbox = {
    calls,
    describe,
    exec,
    exists,
    mkdir,
    readdir,
    readFile,
    readFileBuffer,
    resolvePath,
    rm,
    stat,
    writeFile,
    ...(options.withoutStreaming === true ? {} : { readTextStream }),
    ...(options.withoutHead === true ? {} : { readHead }),
  };
  return sandbox;
}

/**
 * 假适配器：每个沙箱 id 拿一份全新内存沙箱，物理 id 按 `fake-<id>` 回报。
 *
 * 它让宿主的「拿沙箱」链路也能在测试里跑通，而不用碰真实环境。
 */
export function createFakeSandboxAdapter(
  options: FakeSandboxOptions = {}
): SandboxAdapter {
  return {
    name: "fake",
    acquire: (input) =>
      Promise.resolve({
        physicalId: `fake-${input.id}`,
        sandbox: createFakeSandbox(options),
      }),
  };
}
