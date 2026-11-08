/**
 * 工作区文件的读模型：列目录、取元数据、按行读文本、读完整字节。
 *
 * 四个操作共用同一条闸门（`workspace.paths.ts`）和同一套上限，所以放在一个模块里。
 * 这里不碰数据库：会话到根的解析在路由层完成，测试可以直接构造根。
 */
import type { Dirent, Stats } from "node:fs";
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";

import { ApiError } from "../../errors";
import {
  directoryKindOf,
  resolveRegularFile,
  resolveTarget,
  versionOf,
  workspacePathOf,
} from "./workspace.paths";
import type { WorkspaceRoots } from "./workspace.paths";

// ── 上限 ────────────────────────────────────────────────────────────────────
export interface WorkspaceLimits {
  /** 单页文本或单次字节窗口的上限。 */
  readonly maxBytes: number;
  /** 一次读取完整文件的上限。 */
  readonly maxFileBytes: number;
  /** 单页最大行数。 */
  readonly maxLines: number;
  /** 一次列目录返回的最大条目数。 */
  readonly maxEntries: number;
}

export const DEFAULT_LIMITS: WorkspaceLimits = {
  maxBytes: 2 * 1024 * 1024,
  maxFileBytes: 32 * 1024 * 1024,
  maxLines: 5000,
  maxEntries: 2000,
};

/** 一次读取的附加选项：上限可被测试收窄，取消信号来自请求本身。 */
export interface WorkspaceReadOptions {
  readonly limits?: WorkspaceLimits;
  readonly signal?: AbortSignal;
}

// ── 列目录 ──────────────────────────────────────────────────────────────────

/** 目录里的一个直接子项；大小暂不返回，界面也不画。 */
export interface WorkspaceEntry {
  readonly name: string;
  readonly type: "file" | "directory" | "other";
}

export interface WorkspaceListing {
  /** 被列的目录相对主目录的写法；根是空串。 */
  readonly path: string;
  /** 主目录的名字；界面把它画成文件树的根标题。 */
  readonly rootName: string;
  readonly entries: readonly WorkspaceEntry[];
  /** 条目超过上限，后面的被丢弃。 */
  readonly truncated: boolean;
}

/** 目录在前，再按名称自然序；与界面上的显示顺序一致。 */
const ORDER = { directory: 0, file: 1, other: 2 } as const;

function compareEntries(a: WorkspaceEntry, b: WorkspaceEntry): number {
  return (
    ORDER[a.type] - ORDER[b.type] ||
    a.name.localeCompare(b.name, undefined, {
      numeric: true,
      sensitivity: "base",
    })
  );
}

/** 一个子项的类型；链接按目标类型报告，目标不可读时归入 other。 */
async function entryOf(
  parent: string,
  dirent: Dirent
): Promise<WorkspaceEntry> {
  if (dirent.isDirectory()) {
    return { name: dirent.name, type: "directory" };
  }
  if (dirent.isFile()) {
    return { name: dirent.name, type: "file" };
  }
  if (!dirent.isSymbolicLink()) {
    return { name: dirent.name, type: "other" };
  }
  let target: Stats | undefined;
  try {
    target = await stat(join(parent, dirent.name));
  } catch {
    // 悬空链接或权限不足：按 other 报告，目录本身仍然列得完整。
    target = undefined;
  }
  if (target?.isDirectory()) {
    return { name: dirent.name, type: "directory" };
  }
  if (target?.isFile()) {
    return { name: dirent.name, type: "file" };
  }
  return { name: dirent.name, type: "other" };
}

/**
 * 列出一个目录的直接子项。
 *
 * 末尾可以是目录，也可以是指向目录的链接；链接按目标判断，但目标必须在
 * 允许的根内（`resolveTarget` 已经保证）。
 *
 * @param workspace - 允许访问的根。
 * @param inputPath - 绝对路径，或相对主目录的路径。
 * @param options - 只有上限：列目录不持长连接，没有可取消的等待。
 */
export async function listEntries(
  workspace: WorkspaceRoots,
  inputPath: string,
  options: Pick<WorkspaceReadOptions, "limits"> = {}
): Promise<WorkspaceListing> {
  const limits = options.limits ?? DEFAULT_LIMITS;
  const target = await resolveTarget(workspace, inputPath);
  // 末尾是链接时按目标判断；只有目录（含指向目录的链接）能列出。
  const info = target.isSymlink ? await stat(target.realPath) : target.info;
  if (!info.isDirectory()) {
    throw new ApiError("WORKSPACE_NOT_DIRECTORY", {
      data: { path: inputPath, kind: directoryKindOf(target) },
    });
  }

  const dirents = await readdir(target.realPath, { withFileTypes: true });
  const listed = await Promise.all(
    dirents.map((dirent) => entryOf(target.realPath, dirent))
  );
  const entries = listed.toSorted(compareEntries);

  return {
    path: await workspacePathOf(workspace, target.realPath),
    rootName: basename(workspace.primaryDir) || workspace.primaryDir,
    entries: entries.slice(0, limits.maxEntries),
    truncated: entries.length > limits.maxEntries,
  };
}

// ── 元数据 ──────────────────────────────────────────────────────────────────

export interface WorkspaceFileStat {
  /** 解析符号链接后的真实路径。 */
  readonly absolutePath: string;
  /** 只比较、不解析的版本号。 */
  readonly version: string;
  /** 文件的字节数。 */
  readonly bytes: number;
}

/**
 * 读取一个普通文件的元数据。
 *
 * @param workspace - 允许访问的根。
 * @param inputPath - 绝对路径，或相对主目录的路径。
 */
export async function statWorkspaceFile(
  workspace: WorkspaceRoots,
  inputPath: string
): Promise<WorkspaceFileStat> {
  const target = await resolveRegularFile(workspace, inputPath);
  return {
    absolutePath: target.realPath,
    version: versionOf(target.fileInfo),
    bytes: target.fileInfo.size,
  };
}

// ── 文本分页 ────────────────────────────────────────────────────────────────

/** 第几行开始、取多少行；都省略时从头取满一页。 */
export interface WorkspaceTextRange {
  readonly offset?: number;
  readonly limit?: number;
}

export interface WorkspaceTextPage {
  readonly absolutePath: string;
  readonly version: string;
  /** 整个文件的字节数，不是本页的。 */
  readonly bytes: number;
  /** 本页第一行的行号，1 起。 */
  readonly offset: number;
  /** 行之间用 `\n` 连接，末尾不带终止符。 */
  readonly text: string;
  /** 本页的行数；`0` 表示 offset 已过末行。 */
  readonly lines: number;
  /** 本页是否包含文件的最后一行。 */
  readonly eof: boolean;
}

/**
 * 不能按文本预览的原因。
 *
 * 这三种情况没有坏：文件在，只是不适合当文本打开。界面要把原因画在文件区
 * 里，所以它们按结果返回，不按失败抛出——失败会触发全局错误提示，而那提示
 * 对一个用户刚点开的文件没有意义。
 */
export type WorkspaceTextRefusal =
  | "not-text"
  | "not-regular-file"
  | "too-large";

/** 读一页文本的结果：这一页，或不能预览的原因。 */
export type WorkspaceTextResult =
  | ({ readonly kind: "text" } & WorkspaceTextPage)
  | {
      readonly kind: "refused";
      readonly path: string;
      readonly reason: WorkspaceTextRefusal;
    };

/** 文本里不允许出现的字节：出现即视为二进制。 */
const NUL = String.fromCodePoint(0);

interface Page {
  readonly text: string;
  readonly lines: number;
  readonly eof: boolean;
}

/**
 * 把文本流切成第 offset 行起的 limit 行。
 *
 * 每段先按 UTF-8 字节数计入上限，超了整体失败，不静默截断——截断的页会被
 * 当成整页读。行以 `\n` 结束，末行有没有 `\n` 都不会多出一行。
 */
async function cutPage(
  chunks: AsyncIterable<string>,
  offset: number,
  limit: number,
  maxBytes: number,
  path: string
): Promise<Page> {
  const last = offset + limit - 1;
  const lines: string[] = [];
  let current = "";
  let bytes = 0;
  let lineNumber = 1;

  const admit = (size: number): void => {
    bytes += size;
    if (bytes > maxBytes) {
      throw new ApiError("WORKSPACE_TOO_LARGE", {
        data: { path, limit: maxBytes },
      });
    }
  };
  const complete = (): void => {
    if (lines.length > 0) {
      admit(1);
    }
    lines.push(current);
    current = "";
  };

  for await (const chunk of chunks) {
    let position = 0;
    while (position < chunk.length) {
      if (lineNumber > last) {
        return { text: lines.join("\n"), lines: lines.length, eof: false };
      }
      const newline = chunk.indexOf("\n", position);
      const segment =
        newline === -1 ? chunk.slice(position) : chunk.slice(position, newline);
      if (lineNumber >= offset) {
        admit(Buffer.byteLength(segment, "utf-8"));
        current += segment;
      }
      if (newline === -1) {
        break;
      }
      if (lineNumber >= offset) {
        complete();
      }
      lineNumber += 1;
      position = newline + 1;
    }
  }

  // 只有页内的行可能还挂着：页前的行没保留，页后的字符在上面已经返回。
  if (current.length > 0) {
    complete();
  }
  return { text: lines.join("\n"), lines: lines.length, eof: true };
}

/**
 * 逐块解码 UTF-8；非法字节序列按「不是文本」处理。
 *
 * @param path - 要读的文件。
 * @param signal - 取消信号。
 * @yields 已解码的文本块。
 */
async function* decodeUtf8(
  path: string,
  signal?: AbortSignal
): AsyncGenerator<string> {
  const stream = createReadStream(path, signal ? { signal } : undefined);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    for await (const chunk of stream) {
      yield decoder.decode(chunk as Buffer, { stream: true });
    }
    yield decoder.decode();
  } catch (error: unknown) {
    if (error instanceof TypeError) {
      throw new ApiError("WORKSPACE_NOT_TEXT", { data: { path } });
    }
    throw error;
  }
}

/**
 * 这几种失败换成「不能预览」的原因，交给界面画在文件区里。
 *
 * 用 `switch` 而不是查表，是因为 `ApiError` 的 `code` 经过 `instanceof`
 * 收窄后仍是宽联合；查表需要索引签名，会让类型检查认为键是 `any`。
 */
function refusalOf(error: unknown): WorkspaceTextRefusal | undefined {
  if (!(error instanceof ApiError)) {
    return;
  }
  switch (error.code) {
    case "WORKSPACE_NOT_REGULAR_FILE": {
      return "not-regular-file";
    }
    case "WORKSPACE_NOT_TEXT": {
      return "not-text";
    }
    case "WORKSPACE_TOO_LARGE": {
      return "too-large";
    }
    default: {
      // 其余错误与预览无关，交给调用方继续抛。
      break;
    }
  }
}

/**
 * 读取一个文本文件的一页。
 *
 * 全程流式：读到页尾的第一个字符就停，页前的行只计数不保留，所以大文件也
 * 只花一页的内存。
 *
 * 路径不存在或越界仍是失败；「不是文本」「不是普通文件」「超出上限」是这份
 * 文件的属性，按 `refused` 结果返回，让界面在文件区里说明原因。
 *
 * @param workspace - 允许访问的根。
 * @param inputPath - 绝对路径，或相对主目录的路径。
 * @param range - 行窗口；省略时取整页默认值。
 * @param options - 上限与取消信号。
 */
export async function readTextPage(
  workspace: WorkspaceRoots,
  inputPath: string,
  range: WorkspaceTextRange,
  options: WorkspaceReadOptions = {}
): Promise<WorkspaceTextResult> {
  const limits = options.limits ?? DEFAULT_LIMITS;
  const offset = range.offset ?? 1;
  const limit = range.limit ?? limits.maxLines;

  if (!Number.isSafeInteger(offset) || offset < 1) {
    throw new ApiError("BAD_REQUEST", {
      message: "offset must be a positive integer",
    });
  }
  if (limit < 1 || limit > limits.maxLines) {
    throw new ApiError("BAD_REQUEST", {
      message: `limit must be between 1 and ${limits.maxLines}`,
    });
  }

  try {
    const target = await resolveRegularFile(workspace, inputPath);
    const page = await cutPage(
      decodeUtf8(target.realPath, options.signal),
      offset,
      limit,
      limits.maxBytes,
      inputPath
    );
    if (page.text.includes(NUL)) {
      throw new ApiError("WORKSPACE_NOT_TEXT", { data: { path: inputPath } });
    }

    return {
      kind: "text",
      absolutePath: target.realPath,
      version: versionOf(target.fileInfo),
      bytes: target.fileInfo.size,
      offset,
      text: page.text,
      lines: page.lines,
      eof: page.eof,
    };
  } catch (error: unknown) {
    const reason = refusalOf(error);
    if (reason === undefined) {
      throw error;
    }
    return { kind: "refused", path: inputPath, reason };
  }
}

// ── 完整字节 ────────────────────────────────────────────────────────────────

export interface WorkspaceFileBytes {
  /** 解析符号链接后的真实路径。 */
  readonly absolutePath: string;
  /** 只比较、不解析的版本号。 */
  readonly version: string;
  /** 返回的字节数。 */
  readonly bytes: number;
  /** 原生字节；`ArrayBuffer` 泛型让它可以直接交给 `Response`。 */
  readonly data: Uint8Array<ArrayBuffer>;
}

/** 边读边计数，超过上限立刻失败，不把整个文件留在内存里。 */
async function readBounded(
  path: string,
  maxBytes: number,
  inputPath: string,
  signal?: AbortSignal
): Promise<Uint8Array<ArrayBuffer>> {
  const stream = createReadStream(path, signal ? { signal } : undefined);
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of stream) {
    const buffer = chunk as Buffer;
    total += buffer.byteLength;
    if (total > maxBytes) {
      stream.destroy();
      throw new ApiError("WORKSPACE_TOO_LARGE", {
        data: { path: inputPath, limit: maxBytes },
      });
    }
    chunks.push(buffer);
  }

  return new Uint8Array(Buffer.concat(chunks));
}

/**
 * 读取一个普通文件的完整字节。
 *
 * 不做任何解码，也不判断内容类型：图片、PDF、未知格式都走这里。上限在读取
 * 过程中检查，文件在上限之后继续变长也只读到上限为止，然后报错。
 *
 * @param workspace - 允许访问的根。
 * @param inputPath - 绝对路径，或相对主目录的路径。
 * @param options - 上限与取消信号。
 */
export async function readFileBytes(
  workspace: WorkspaceRoots,
  inputPath: string,
  options: WorkspaceReadOptions = {}
): Promise<WorkspaceFileBytes> {
  const limits = options.limits ?? DEFAULT_LIMITS;
  const target = await resolveRegularFile(workspace, inputPath);

  // 先按元数据拒绝，省掉一次注定失败的完整读取；读取过程中还会再挡一次。
  if (target.fileInfo.size > limits.maxFileBytes) {
    throw new ApiError("WORKSPACE_TOO_LARGE", {
      data: { path: inputPath, limit: limits.maxFileBytes },
    });
  }

  const data = await readBounded(
    target.realPath,
    limits.maxFileBytes,
    inputPath,
    options.signal
  );
  return {
    absolutePath: target.realPath,
    version: versionOf(target.fileInfo),
    bytes: data.byteLength,
    data,
  };
}
