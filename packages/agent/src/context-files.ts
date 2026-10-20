import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";

import { logger } from "@workspace/shared/logger";

import { getGlobalResourceRoots } from "./resource-dirs.js";
import { normalizeToolInputPath } from "./utils/fs-util.js";

/** 一个被加载的上下文文件；`path` 会原样写进系统提示，模型靠它区分全局与项目。 */
export interface ContextFile {
  path: string;
  content: string;
}

export interface LoadProjectContextFilesOptions {
  /** 工作目录。加载会从它一路向上到根目录。 */
  cwd: string;
  /**
   * 用户级上下文目录，按优先级排列。每个目录最多贡献一个文件，全部按顺序
   * 拼接在项目文件之前。
   *
   * 省略时使用 `~/.aify-studio`、`~/.agents`；传 `[]` 可以完全关闭全局加载。
   */
  globalDirs?: string[];
}

/** 用户级上下文目录名，按优先级排列。 */
export const GLOBAL_CONTEXT_DIR_NAMES = [".aify-studio", ".agents"] as const;

/** 把 {@link GLOBAL_CONTEXT_DIR_NAMES} 展开成 `home` 下的绝对路径。 */
export function getGlobalContextDirs(home: string = homedir()): string[] {
  return getGlobalResourceRoots(GLOBAL_CONTEXT_DIR_NAMES, home).map(
    ({ root }) => root
  );
}

/**
 * 每个目录的候选文件名，按优先级排列。
 *
 * 同一目录只会选中第一个存在的普通文件：`AGENTS.override.md` 覆盖同目录的
 * `AGENTS.md` / `CLAUDE.md`，但不会压制其他目录。大写扩展名是 Windows 上
 * 常见的写法，保留是为了让同一份仓库在各平台行为一致。
 */
export const CONTEXT_FILE_NAMES = [
  "AGENTS.override.md",
  "AGENTS.md",
  "AGENTS.MD",
  "CLAUDE.md",
  "CLAUDE.MD",
] as const;

interface GitPaths {
  /** 工作树根目录。 */
  repoDir: string;
  /** 主仓库的 git 目录；linked worktree 与主仓库共享它。 */
  commonGitDir: string;
}

function stripBom(text: string): string {
  return text.codePointAt(0) === 0xfe_ff ? text.slice(1) : text;
}

/** 支持 `~` 与相对路径，统一成绝对路径。 */
function resolveInput(input: string): string {
  return resolve(normalizeToolInputPath(input));
}

function canonicalizePath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * 从 `dir` 开始向上找 `.git`，返回工作树根与共享 git 目录。
 *
 * 不调用 git 二进制：普通仓库的 `.git` 是目录，linked worktree 的 `.git` 是
 * 一个内容为 `gitdir: <path>` 的文件，两种情况都能直接读出来。
 */
function findGitPaths(cwd: string): GitPaths | null {
  let dir = cwd;

  while (true) {
    const gitPath = join(dir, ".git");
    if (existsSync(gitPath)) {
      try {
        const stat = statSync(gitPath);
        if (stat.isFile()) {
          const content = readFileSync(gitPath, "utf-8").trim();
          if (content.startsWith("gitdir: ")) {
            const gitDir = resolve(dir, content.slice(8).trim());
            if (!existsSync(join(gitDir, "HEAD"))) {
              return null;
            }
            const commonDirPath = join(gitDir, "commondir");
            const commonGitDir = existsSync(commonDirPath)
              ? resolve(gitDir, readFileSync(commonDirPath, "utf-8").trim())
              : gitDir;
            return { repoDir: dir, commonGitDir };
          }
        } else if (stat.isDirectory()) {
          if (!existsSync(join(gitPath, "HEAD"))) {
            return null;
          }
          return { repoDir: dir, commonGitDir: gitPath };
        }
      } catch {
        return null;
      }
    }

    const parent = dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

/**
 * 找出「嵌套在仓库内部的 worktree」会重复加载的那份主仓库上下文文件。
 *
 * 例如主仓库在 `proj/main`，worktree 在 `proj/main/worktrees/feat`：从 worktree
 * 向上遍历会经过主仓库根，于是 worktree 自己的 `AGENTS.md` 和主仓库的
 * `AGENTS.md` 会被同时加载。两者属于同一逻辑仓库，重复注入没有意义。
 *
 * 返回主仓库根下与 worktree 上下文文件同名的路径；没有可跳过的文件时返回
 * undefined，保持正常的祖先继承。返回值经过 realpath 处理：`git worktree add`
 * 写进 `.git` 文件的 `gitdir:` 是真实路径，而 cwd 可能仍是软链接。
 *
 * 同级 worktree（`git worktree add ../feat`）的主仓库不是它的祖先，不会命中；
 * bare 布局（`proj/.bare` + `proj/main`）里 `dirname(commonGitDir)` 只是存放
 * `.bare` 的普通目录，也不命中。
 */
function findShadowedContextFile(cwd: string): string | undefined {
  const gitPaths = findGitPaths(cwd);
  if (!gitPaths) {
    return undefined;
  }

  const commonGitDir = canonicalizePath(gitPaths.commonGitDir);
  const worktreeRoot = canonicalizePath(gitPaths.repoDir);
  const mainRepoRoot = dirname(commonGitDir);

  // 普通仓库里两者相同；同级 worktree 的主仓库不在祖先链上。
  if (!worktreeRoot.startsWith(`${mainRepoRoot}${sep}`)) {
    return undefined;
  }
  // commonGitDir 的父目录只有在该目录本身就是主工作树时才代表主仓库根。
  // bare 布局和子模块都会落到别的目录，那里并不跟踪任何东西。
  if (canonicalizePath(join(mainRepoRoot, ".git")) !== commonGitDir) {
    return undefined;
  }

  const worktreeContextFile = loadContextFileFromDir(worktreeRoot);
  return worktreeContextFile
    ? join(mainRepoRoot, basename(worktreeContextFile.path))
    : undefined;
}

/**
 * 读取一个目录下的上下文文件，按 {@link CONTEXT_FILE_NAMES} 的优先级取第一个
 * 普通文件。目录同名会被跳过，读失败只记警告，不影响其他目录。
 */
export function loadContextFileFromDir(dir: string): ContextFile | null {
  for (const filename of CONTEXT_FILE_NAMES) {
    const filePath = join(dir, filename);
    if (!existsSync(filePath)) {
      continue;
    }
    try {
      if (!statSync(filePath).isFile()) {
        continue;
      }
      return {
        path: filePath,
        content: stripBom(readFileSync(filePath, "utf-8")),
      };
    } catch (error) {
      logger.warn(`[context-files] 读取 ${filePath} 失败`, error);
    }
  }

  return null;
}

/**
 * 加载全局上下文与 cwd 祖先链上的所有上下文文件。
 *
 * 顺序是「全局 → 最远祖先 → cwd」。越靠近 cwd 的说明越靠后，模型通常会把
 * 后出现的内容当成更具体的指令。只沿祖先链查找，不扫描子目录：在仓库根启动
 * 时不会加载 `packages/x/AGENTS.md`。
 */
export function loadProjectContextFiles(
  options: LoadProjectContextFilesOptions
): ContextFile[] {
  const resolvedCwd = resolveInput(options.cwd);
  const resolvedGlobalDirs = (options.globalDirs ?? getGlobalContextDirs()).map(
    resolveInput
  );

  const contextFiles: ContextFile[] = [];
  const seenPaths = new Set<string>();

  for (const dir of resolvedGlobalDirs) {
    const globalContext = loadContextFileFromDir(dir);
    if (globalContext && !seenPaths.has(globalContext.path)) {
      contextFiles.push(globalContext);
      seenPaths.add(globalContext.path);
    }
  }

  const ancestorContextFiles: ContextFile[] = [];
  const shadowedContextFile = findShadowedContextFile(resolvedCwd);
  let currentDir = resolvedCwd;

  while (true) {
    const contextFile = loadContextFileFromDir(currentDir);
    // 比较目录的真实路径而不是文件的：worktree 里指向主仓库文件的软链接，
    // 解析后就是被跳过的那个路径本身。
    const isShadowed =
      shadowedContextFile !== undefined &&
      contextFile !== null &&
      join(canonicalizePath(currentDir), basename(contextFile.path)) ===
        shadowedContextFile;

    if (contextFile && !isShadowed && !seenPaths.has(contextFile.path)) {
      ancestorContextFiles.unshift(contextFile);
      seenPaths.add(contextFile.path);
    }

    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      break;
    }
    currentDir = parentDir;
  }

  contextFiles.push(...ancestorContextFiles);

  return contextFiles;
}

/**
 * 把上下文文件渲染成系统提示里的一节。
 *
 * 每个文件用 `<project_instructions path="...">` 包起来，路径是模型区分全局
 * 说明和项目说明的唯一依据。内容原样注入，不做截断或转义。
 */
export function renderProjectContext(files: ContextFile[]): string {
  if (files.length === 0) {
    return "";
  }

  return [
    "Project-specific instructions and guidelines:",
    ...files.map(
      ({ path, content }) =>
        `<project_instructions path="${path}">\n${content}\n</project_instructions>`
    ),
  ].join("\n\n");
}
