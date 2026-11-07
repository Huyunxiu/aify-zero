/**
 * Markdown 链接目标的分类。
 *
 * 这里只做字符串判断：不访问文件系统，也不解析路径。相对路径的基准目录由
 * 服务端决定，和 agent 工具用的是同一个根，所以前端不必知道工作区在哪。
 *
 * 分类结果决定渲染方式：
 * - `file`：交给当前会话在右侧面板打开，可带行号。
 * - `external`：HTTP(S)、`mailto:`、`tel:`，新窗口打开。
 * - `plain`：页内锚点和带查询串的目标，保持浏览器默认行为。
 * - `blocked`：`javascript:` 之类不安全的协议，以及无法安全解码的目标，只显示文字。
 */

/** 一个本地文件链接的目标：路径，以及可选的第一个行号。 */
export interface FileOpenTarget {
  readonly path: string;
  /** 链接里写明的行号；没有写或写得不合法时缺省。 */
  readonly line?: number;
}

/** 一个 Markdown 目标的分类结果。 */
export type MarkdownHref =
  | ({ readonly kind: "file" } & FileOpenTarget)
  | { readonly kind: "external"; readonly href: string }
  | { readonly kind: "plain"; readonly href: string }
  | { readonly kind: "blocked" };

/** 协议头：字母开头，后面允许数字、`+`、`.`、`-`。 */
const SCHEME = /^[a-z][a-z0-9+.-]*:/iu;

/** Windows 盘符路径要先于协议判断，否则 `C:` 会被当成一个协议。 */
const DRIVE = /^[a-z]:[\\/]/iu;

/** 用反斜杠表示层级的路径：盘符、UNC，或整串都没有正斜杠。 */
const WINDOWS_PREFIX = /^(?:[a-z]:[\\/]|\\\\)/iu;

/** 可以交给浏览器的协议；其余带协议的目标一律不渲染成链接。 */
const EXTERNAL_SCHEMES = new Set(["http", "https", "mailto", "tel"]);

/** 控制字符不能进入路径。 */
function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;

    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }

  return false;
}

/** 行号后缀：`:24`、`:24-30`、`:24:5`（第三段是列，读掉但不用）。 */
const LINE_SUFFIX = /:(\d+)(?::\d+|-(\d+))?$/u;

/** 片段行号：`#L24`、`#L24-L30`。 */
const LINE_FRAGMENT = /^L(\d+)(?:-L(\d+))?$/u;

/** 是否是反斜杠写法的路径。 */
function isWindowsShaped(value: string): boolean {
  return (
    WINDOWS_PREFIX.test(value) || (value.includes("\\") && !value.includes("/"))
  );
}

/**
 * 统一成树里用的写法：正斜杠，去掉开头的 `./` 和结尾的 `/`。
 *
 * 目录链接也走同一条路：结尾的斜杠去掉后，服务端会按普通文件拒绝它，
 * 预览区给出对应的说明，标签页也还能显示目录名。
 */
function normalizePath(value: string): string {
  const slashed = isWindowsShaped(value) ? value.replaceAll("\\", "/") : value;
  const trimmed = slashed.replace(/^(?:\.\/)+/u, "");

  // 根目录本身保留斜杠，否则会变成空串。
  return trimmed === "/" ? trimmed : trimmed.replace(/\/+$/u, "");
}

/**
 * 解析行号，并拒绝不合法的范围。
 *
 * @param start - 起始行；缺省表示没有行号。
 * @param end - 结束行；缺省表示只有一行。
 * @returns 起始行；不合法时返回 undefined，调用方只打开文件。
 */
function lineOf(
  start: string | undefined,
  end: string | undefined
): number | undefined {
  if (start === undefined) {
    return undefined;
  }

  const first = Number(start);
  const last = end === undefined ? first : Number(end);

  if (!(Number.isSafeInteger(first) && Number.isSafeInteger(last))) {
    return undefined;
  }

  if (first < 1 || last < first) {
    return undefined;
  }

  return first;
}

/** 从 `#` 后的片段里取行号；不是行号片段时返回 undefined。 */
function lineFromFragment(fragment: string): number | undefined {
  let decoded: string;

  try {
    decoded = decodeURIComponent(fragment);
  } catch {
    // 片段解码失败不影响文件本身，只丢掉行号。
    return undefined;
  }

  const match = LINE_FRAGMENT.exec(decoded);

  return match === null ? undefined : lineOf(match[1], match[2]);
}

/**
 * 把一个链接目标解析成本地文件。
 *
 * 片段（`#L24`）优先：有片段时不再解析冒号后缀。百分号转义的冒号不算后缀，
 * 所以 `notes%3A24` 是文件名。行号不合法时只返回路径。
 *
 * @param destination - Markdown 里的目标原文。
 * @returns 路径与可选行号；URL、页内锚点、查询串和无法解码的目标返回 null。
 */
export function parseFileLink(destination: string): FileOpenTarget | null {
  const hash = destination.indexOf("#");
  const head = hash === -1 ? destination : destination.slice(0, hash);

  if (head.includes("?")) {
    return null;
  }

  let decoded: string;

  try {
    decoded = decodeURIComponent(head);
  } catch {
    // 畸形的百分号转义无法可靠地指向一个文件。
    return null;
  }

  if (decoded === "" || hasControlCharacter(decoded)) {
    return null;
  }

  if (hash === -1) {
    const suffix = LINE_SUFFIX.exec(head);

    if (suffix !== null) {
      const path = normalizePath(
        decoded.slice(0, decoded.length - suffix[0].length)
      );

      if (path === "") {
        return null;
      }

      const line = lineOf(suffix[1], suffix[2]);

      return line === undefined ? { path } : { line, path };
    }
  }

  const path = normalizePath(decoded);

  if (path === "") {
    return null;
  }

  if (hash === -1) {
    return { path };
  }

  const line = lineFromFragment(destination.slice(hash + 1));

  return line === undefined ? { path } : { line, path };
}

/**
 * 判定一个 Markdown 目标应该怎么渲染。
 *
 * @param raw - `href` 原文。
 * @returns 分类结果；无法解析的相对目标按 `blocked` 处理，避免浏览器跳走。
 */
export function classifyMarkdownHref(raw: string): MarkdownHref {
  const href = raw.trim();

  if (href === "") {
    return { kind: "plain", href };
  }

  if (href.startsWith("#")) {
    return { kind: "plain", href };
  }

  if (DRIVE.test(href)) {
    const file = parseFileLink(href);

    return file === null ? { kind: "blocked" } : { kind: "file", ...file };
  }

  if (SCHEME.test(href)) {
    const scheme = href.slice(0, href.indexOf(":")).toLowerCase();

    return EXTERNAL_SCHEMES.has(scheme)
      ? { kind: "external", href }
      : { kind: "blocked" };
  }

  if (href.includes("?")) {
    return { kind: "plain", href };
  }

  const file = parseFileLink(href);

  return file === null ? { kind: "blocked" } : { kind: "file", ...file };
}
