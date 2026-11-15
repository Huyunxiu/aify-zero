/**
 * 路径归一的共用实现。
 *
 * 这一份服务本机：它认 Windows 盘符、`~`、`file://` 和 Unicode 空格。远端适配器
 * 自己实现 `resolvePath`，因为它的分隔符和 home 与本机无关；但输入归一那几条规则
 * （`@` 前缀、Unicode 空格、`file://`）与平台无关，两边要一致。
 */
import { realpathSync } from "node:fs";
import { isAbsolute, join, resolve as pathResolve, posix } from "node:path";
import { fileURLToPath } from "node:url";

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

/** 把 `/c/…`、`/mnt/c/…`、`/cygdrive/c/…` 这类路径换成 Windows 盘符形式。 */
export function windowsPath(p: string): string {
  return p
    .replace(
      /^\/([a-zA-Z]):(?:[\\/]|$)/u,
      (_match: string, drive: string) => `${drive.toUpperCase()}:/`
    )
    .replace(
      /^\/([a-zA-Z])(?:\/|$)/u,
      (_match: string, drive: string) => `${drive.toUpperCase()}:/`
    )
    .replace(
      /^\/cygdrive\/([a-zA-Z])(?:\/|$)/u,
      (_match: string, drive: string) => `${drive.toUpperCase()}:/`
    )
    .replace(
      /^\/mnt\/([a-zA-Z])(?:\/|$)/u,
      (_match: string, drive: string) => `${drive.toUpperCase()}:/`
    );
}

/** 按当前平台归一化路径；Windows 上再走一次 `realpath` 展开短名。 */
export function normalizePath(p: string): string {
  if (process.platform !== "win32") {
    return posix.normalize(p);
  }
  const resolved = pathResolve(windowsPath(p));
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

/**
 * 把模型给出的路径归一化成文件系统能直接使用的形式：
 * - Unicode 空格（不换行空格、全角空格等）换成普通空格
 * - 去掉 CLI 风格的 `@` 前缀
 * - 展开开头的 `~`
 * - 把 `file://` URL 转成本地路径
 *
 * 与 `normalizeForFuzzyMatch` 里的空格处理保持一致，否则同一个路径在
 * “匹配文本”和“定位文件”两条链路上会得到不同结果。
 */
export function normalizeInputPath(filepath: string, home: string): string {
  let normalized = filepath.replace(UNICODE_SPACES, " ");

  if (normalized.startsWith("@")) {
    normalized = normalized.slice(1);
  }

  if (normalized === "~") {
    return home;
  }
  if (normalized.startsWith("~/") || normalized.startsWith("~\\")) {
    return join(home, normalized.slice(2));
  }

  if (normalized.startsWith("file://")) {
    return fileURLToPath(normalized);
  }

  return normalized;
}

/**
 * 解析一个工具给出的路径：相对路径按 `cwd` 解析而不是拒绝。
 *
 * 模型只有一个基准目录，拒绝只会多一次往返，消不掉歧义。
 */
export function resolveSandboxPath(
  filepath: string,
  context: { cwd: string; home: string }
): string {
  const input = normalizeInputPath(filepath, context.home);
  return normalizePath(
    isAbsolute(input) ? input : pathResolve(context.cwd, input)
  );
}
