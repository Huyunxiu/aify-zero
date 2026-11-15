/**
 * 原生隔离的写策略：算出一组可写根，再把它渲染成平台各自的约束形式。
 *
 * 两件事刻意不做：不限制网络（跑 `npm install`、`git fetch` 是这个产品的基本
 * 需求），不限制读取（读凭证要配网络才有意义，而限制读取会直接弄坏 `git push`
 * 和 `ssh`）。所以这一层的目标是：命令改不动工作目录以外的文件。
 */
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** 平台原生的隔离手段。 */
export type IsolationBackend = "seatbelt" | "bwrap";

/** `sandbox-exec` 的固定位置；不依赖 PATH，避免被同名程序顶替。 */
export const SEATBELT_BINARY = "/usr/bin/sandbox-exec";

export interface WritePolicyInput {
  readonly projectDirs: readonly string[];
  readonly sessionDir: string;
  /** 额外可写根，例如某个项目自己的构建缓存目录。 */
  readonly extra?: readonly string[];
}

/**
 * 收集可写根。
 *
 * 除了项目目录与会话目录，还必须放行临时目录和常见构建缓存：`npm install`
 * 会写 `~/.npm`，编译器会写 `$TMPDIR`。不放行它们，隔离适配器会把正常构建
 * 变成一堆只读错误。
 */
export function buildWritePolicy(input: WritePolicyInput): readonly string[] {
  const candidates = [
    ...input.projectDirs,
    input.sessionDir,
    ...(input.extra ?? []),
    process.env.TMPDIR,
    "/tmp",
    "/private/tmp",
    join(homedir(), ".npm"),
    join(homedir(), ".cache"),
    join(homedir(), "Library", "Caches"),
  ];

  const roots = new Set<string>();
  for (const candidate of candidates) {
    for (const resolved of resolvedForms(candidate)) {
      roots.add(resolved);
    }
  }

  return [...roots];
}

/**
 * 路径的两种形态：原样与解析符号链接之后。
 *
 * seatbelt 按内核解析后的真实路径匹配，而 `TMPDIR` 在 macOS 上通常是
 * `/var/folders/...`，真实路径是 `/private/var/folders/...`。两边都放行，免得
 * 策略在一个平台上悄悄少了权限。
 */
function resolvedForms(path: string | undefined): string[] {
  if (path === undefined || path.length === 0) {
    return [];
  }
  const forms = [path];
  if (existsSync(path)) {
    try {
      const real = realpathSync(path);
      if (real !== path) {
        forms.push(real);
      }
    } catch {
      // 解析失败就只用原样路径。
    }
  }
  return forms;
}

/**
 * 判断一个绝对路径是否落在可写根里。
 *
 * 逐段比较而不是看前缀字符串：`/work/alpha-sibling` 不该被 `/work/alpha` 放行。
 */
export function isWritablePath(
  path: string,
  roots: readonly string[]
): boolean {
  return roots.some((root) => {
    if (path === root) {
      return true;
    }
    const prefix = root.endsWith("/") ? root : `${root}/`;
    return path.startsWith(prefix);
  });
}

/** SBPL 字符串里的双引号与反斜杠要转义，否则策略语法会被路径截断。 */
function escapeSbpl(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

/**
 * 渲染 seatbelt 策略。
 *
 * 顺序是先 `allow default` 再把写入整体关掉，最后按根放行：这比逐条列允许项
 * 稳，因为新出现的系统路径默认是只读而不是不可预期。
 */
export function buildSeatbeltProfile(roots: readonly string[]): string {
  const rules = roots.map((root) => `  (subpath "${escapeSbpl(root)}")`);

  // 设备与已打开的管道必须可写，否则任何重定向都会失败。
  rules.push(
    '  (literal "/dev/null")',
    '  (literal "/dev/stdout")',
    '  (literal "/dev/stderr")',
    '  (literal "/dev/tty")',
    '  (regex #"^/dev/fd/")'
  );

  return [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    "(allow file-write*",
    rules.join("\n"),
    ")",
  ].join("\n");
}

export interface IsolatedInvocation {
  readonly file: string;
  readonly args: readonly string[];
}

/** 把 shell 的 argv 包进 seatbelt。 */
export function buildSeatbeltInvocation(
  roots: readonly string[],
  shellArgv: readonly string[]
): IsolatedInvocation {
  return {
    file: SEATBELT_BINARY,
    args: ["-p", buildSeatbeltProfile(roots), ...shellArgv],
  };
}

/**
 * 把 shell 的 argv 包进 bubblewrap。
 *
 * 根文件系统只读挂载，再把每个可写根 bind 成可写；`/dev` 与 `/proc` 单独给一份
 * 可用的，否则 `/dev/null` 在只读挂载下不可写。`--die-with-parent` 保证父进程
 * 被取消时命令不会留在后台。
 */
export function buildBwrapInvocation(
  roots: readonly string[],
  cwd: string,
  shellArgv: readonly string[]
): IsolatedInvocation {
  const args = ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc"];

  for (const root of roots) {
    args.push("--bind", root, root);
  }

  args.push("--chdir", cwd, "--die-with-parent", "--", ...shellArgv);

  return { file: "bwrap", args };
}

/** 按平台选隔离机制；Windows 没有原生手段，返回 `undefined`。 */
export function detectBackend(): IsolationBackend | undefined {
  if (process.platform === "darwin") {
    return "seatbelt";
  }
  if (process.platform === "linux") {
    return "bwrap";
  }
  return undefined;
}
