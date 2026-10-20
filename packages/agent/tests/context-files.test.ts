import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  getGlobalContextDirs,
  loadContextFileFromDir,
  loadProjectContextFiles,
  renderProjectContext,
} from "../src/context-files.js";
import type { ContextFile } from "../src/context-files.js";

/**
 * 只保留测试临时目录下的文件。加载器会一路向上到根目录，真实机器上如果
 * 祖先目录恰好有 AGENTS.md，精确断言就会被污染。
 */
const under = (files: ContextFile[], root: string): ContextFile[] =>
  files.filter((file) => file.path.startsWith(`${root}${sep}`));

/** 先建目录再写文件，省得每个用例都拼一遍。 */
const write = (filePath: string, content: string): void => {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
};

describe("context files", () => {
  let tempDir = "";

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "context-files-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe(loadContextFileFromDir, () => {
    test("should find AGENTS.md", () => {
      const dir = join(tempDir, "project");
      write(join(dir, "AGENTS.md"), "# Guidelines");

      expect(loadContextFileFromDir(dir)).toStrictEqual({
        path: join(dir, "AGENTS.md"),
        content: "# Guidelines",
      });
    });

    test("should prefer AGENTS.override.md over the other candidates", () => {
      const dir = join(tempDir, "project");
      write(join(dir, "AGENTS.override.md"), "override");
      write(join(dir, "AGENTS.md"), "agents");
      write(join(dir, "CLAUDE.md"), "claude");

      expect(loadContextFileFromDir(dir)?.content).toBe("override");
    });

    test("should fall back through AGENTS.md and CLAUDE.md", () => {
      const dir = join(tempDir, "project");
      write(join(dir, "CLAUDE.md"), "claude");
      expect(loadContextFileFromDir(dir)?.path).toBe(join(dir, "CLAUDE.md"));

      write(join(dir, "AGENTS.md"), "agents");
      expect(loadContextFileFromDir(dir)?.path).toBe(join(dir, "AGENTS.md"));
    });

    test("should ignore candidates that are directories", () => {
      const dir = join(tempDir, "project");
      mkdirSync(join(dir, "AGENTS.override.md"), { recursive: true });
      mkdirSync(join(dir, "AGENTS.md"), { recursive: true });
      write(join(dir, "CLAUDE.md"), "fallback");

      expect(loadContextFileFromDir(dir)?.path).toBe(join(dir, "CLAUDE.md"));
    });

    test("should strip a UTF-8 BOM", () => {
      const dir = join(tempDir, "project");
      write(join(dir, "AGENTS.md"), "﻿# Guidelines");

      expect(loadContextFileFromDir(dir)?.content).toBe("# Guidelines");
    });

    test("should return null when the directory has no context file", () => {
      expect(loadContextFileFromDir(tempDir)).toBeNull();
    });
  });

  describe(loadProjectContextFiles, () => {
    test("should load the global file first, then ancestors from far to near", () => {
      const agentDir = join(tempDir, "agent");
      const repo = join(tempDir, "repo");
      const service = join(repo, "service");
      mkdirSync(service, { recursive: true });
      write(join(agentDir, "AGENTS.md"), "global");
      write(join(repo, "AGENTS.md"), "repo");
      write(join(service, "AGENTS.md"), "service");

      const files = under(
        loadProjectContextFiles({ cwd: service, globalDirs: [agentDir] }),
        tempDir
      );

      expect(files.map((file) => file.content)).toStrictEqual([
        "global",
        "repo",
        "service",
      ]);
    });

    test("should let each directory pick its own override", () => {
      const agentDir = join(tempDir, "agent");
      const repo = join(tempDir, "repo");
      const service = join(repo, "service");
      mkdirSync(service, { recursive: true });
      write(join(agentDir, "AGENTS.md"), "global");
      write(join(agentDir, "AGENTS.override.md"), "global override");
      write(join(repo, "AGENTS.md"), "repo");
      write(join(service, "AGENTS.md"), "service");
      write(join(service, "AGENTS.override.md"), "service override");

      const files = under(
        loadProjectContextFiles({ cwd: service, globalDirs: [agentDir] }),
        tempDir
      );

      expect(files.map((file) => file.path)).toStrictEqual([
        join(agentDir, "AGENTS.override.md"),
        join(repo, "AGENTS.md"),
        join(service, "AGENTS.override.md"),
      ]);
    });

    test("should not load the global file twice when cwd is inside agentDir", () => {
      const agentDir = join(tempDir, "agent");
      const project = join(agentDir, "project");
      mkdirSync(project, { recursive: true });
      write(join(agentDir, "AGENTS.md"), "global");

      const files = under(
        loadProjectContextFiles({ cwd: project, globalDirs: [agentDir] }),
        tempDir
      );

      expect(files.map((file) => file.path)).toStrictEqual([
        join(agentDir, "AGENTS.md"),
      ]);
    });

    test("should not scan subdirectories", () => {
      const repo = join(tempDir, "repo");
      const nested = join(repo, "packages", "app");
      mkdirSync(nested, { recursive: true });
      write(join(repo, "AGENTS.md"), "repo");
      write(join(nested, "AGENTS.md"), "nested");

      const files = under(
        loadProjectContextFiles({ cwd: repo, globalDirs: [] }),
        tempDir
      );

      expect(files.map((file) => file.content)).toStrictEqual(["repo"]);
    });

    test("should load only the ancestor chain when globalDirs is empty", () => {
      const repo = join(tempDir, "repo");
      write(join(repo, "AGENTS.md"), "repo");

      const files = under(
        loadProjectContextFiles({ cwd: repo, globalDirs: [] }),
        tempDir
      );

      expect(files.map((file) => file.content)).toStrictEqual(["repo"]);
    });

    test("should load every global dir in the given priority order", () => {
      const first = join(tempDir, "agents");
      const second = join(tempDir, "studio");
      write(join(first, "AGENTS.md"), "first");
      write(join(second, "AGENTS.md"), "second");

      const files = under(
        loadProjectContextFiles({
          cwd: tempDir,
          globalDirs: [first, second],
        }),
        tempDir
      );

      expect(files.map((file) => file.content)).toStrictEqual([
        "first",
        "second",
      ]);
    });

    test("should default to .aify-studio then .agents", () => {
      expect(getGlobalContextDirs("/home/user")).toStrictEqual([
        join("/home/user", ".aify-studio"),
        join("/home/user", ".agents"),
      ]);
    });
  });

  describe("loadProjectContextFiles - nested worktree dedup", () => {
    /**
     * 搭一个 linked worktree 骨架，不需要 git 二进制：主仓库的
     * `.git/worktrees/<name>/` 里有 `HEAD` 和指回主 `.git` 的 `commondir`，
     * worktree 的工作树里则是一个内容为 `gitdir: ...` 的 `.git` 文件。
     */
    const linkWorktree = (
      mainDir: string,
      worktreeDir: string,
      name: string
    ): void => {
      const gitDir = join(mainDir, ".git", "worktrees", name);
      mkdirSync(gitDir, { recursive: true });
      write(join(mainDir, ".git", "HEAD"), "ref: refs/heads/main\n");
      write(join(gitDir, "HEAD"), `ref: refs/heads/${name}\n`);
      write(join(gitDir, "commondir"), "../..");
      write(join(worktreeDir, ".git"), `gitdir: ${gitDir}\n`);
    };

    /** 主仓库在 <tempDir>/outer/main，worktree 在 main/worktrees/feat。 */
    const setupNestedWorktree = () => {
      const outer = join(tempDir, "outer");
      const main = join(outer, "main");
      const worktree = join(main, "worktrees", "feat");
      const worktreeSrc = join(worktree, "src");
      mkdirSync(worktreeSrc, { recursive: true });
      linkWorktree(main, worktree, "feat");
      return { outer, main, worktree, worktreeSrc };
    };

    test("should skip the main repo's duplicate when the worktree has its own context", () => {
      const { main, worktree, worktreeSrc } = setupNestedWorktree();
      write(join(main, "AGENTS.md"), "main repo");
      write(join(worktree, "AGENTS.md"), "worktree");

      const files = under(
        loadProjectContextFiles({ cwd: worktreeSrc, globalDirs: [] }),
        tempDir
      );

      expect(files.map((file) => file.content)).toStrictEqual(["worktree"]);
    });

    test("should load the worktree's context once when it symlinks to the main repo's file", () => {
      const { main, worktree, worktreeSrc } = setupNestedWorktree();
      write(join(main, "AGENTS.md"), "main repo");
      symlinkSync(join(main, "AGENTS.md"), join(worktree, "AGENTS.md"));

      const files = under(
        loadProjectContextFiles({ cwd: worktreeSrc, globalDirs: [] }),
        tempDir
      );

      expect(files.map((file) => file.path)).toStrictEqual([
        join(worktree, "AGENTS.md"),
      ]);
    });

    test("should still inherit the main repo's context when the worktree has none", () => {
      const { main, worktreeSrc } = setupNestedWorktree();
      write(join(main, "AGENTS.md"), "main repo");

      const files = under(
        loadProjectContextFiles({ cwd: worktreeSrc, globalDirs: [] }),
        tempDir
      );

      expect(files.map((file) => file.content)).toStrictEqual(["main repo"]);
    });

    test("should only skip the same filename", () => {
      // 主仓库跟踪 CLAUDE.md，worktree 新增 AGENTS.md。主仓库的 CLAUDE.md 不是
      // 任何文件的重复，丢掉会直接丢失内容。
      const { main, worktree, worktreeSrc } = setupNestedWorktree();
      write(join(main, "CLAUDE.md"), "main repo");
      write(join(worktree, "AGENTS.md"), "worktree");

      const files = under(
        loadProjectContextFiles({ cwd: worktreeSrc, globalDirs: [] }),
        tempDir
      );

      expect(files.map((file) => file.content)).toStrictEqual([
        "main repo",
        "worktree",
      ]);
    });

    test("should keep loading ancestors above the main repo", () => {
      const { outer, main, worktree, worktreeSrc } = setupNestedWorktree();
      write(join(outer, "AGENTS.md"), "outer");
      write(join(main, "AGENTS.md"), "main repo");
      write(join(worktree, "AGENTS.md"), "worktree");

      const files = under(
        loadProjectContextFiles({ cwd: worktreeSrc, globalDirs: [] }),
        tempDir
      );

      // 只丢掉主仓库根这一份重复，它上面的无关目录照常保留。
      expect(files.map((file) => file.content)).toStrictEqual([
        "outer",
        "worktree",
      ]);
    });

    test("should not skip anything for a sibling worktree", () => {
      // git worktree add ../feat 让 worktree 与主仓库平级，主仓库不在祖先链上。
      const outer = join(tempDir, "outer");
      const main = join(outer, "main");
      const sibling = join(outer, "sibling");
      const siblingSrc = join(sibling, "src");
      mkdirSync(siblingSrc, { recursive: true });
      mkdirSync(main, { recursive: true });
      linkWorktree(main, sibling, "sibling");
      write(join(outer, "AGENTS.md"), "outer");
      write(join(sibling, "AGENTS.md"), "sibling");

      const files = under(
        loadProjectContextFiles({ cwd: siblingSrc, globalDirs: [] }),
        tempDir
      );

      expect(files.map((file) => file.content)).toStrictEqual([
        "outer",
        "sibling",
      ]);
    });

    test("should not skip the container's context in a bare layout", () => {
      // proj/.bare + proj/main：commondir 是 ../..，dirname 得到 proj，
      // 而 proj 本身不跟踪任何东西，它的 AGENTS.md 不是重复。
      const proj = join(tempDir, "proj");
      const bare = join(proj, ".bare");
      const worktree = join(proj, "main");
      const worktreeGitDir = join(bare, "worktrees", "main");
      mkdirSync(worktreeGitDir, { recursive: true });
      mkdirSync(worktree, { recursive: true });
      write(join(bare, "HEAD"), "ref: refs/heads/main\n");
      write(join(worktreeGitDir, "HEAD"), "ref: refs/heads/main\n");
      write(join(worktreeGitDir, "commondir"), "../..");
      write(join(worktree, ".git"), `gitdir: ${worktreeGitDir}\n`);
      write(join(proj, "AGENTS.md"), "container");
      write(join(worktree, "AGENTS.md"), "worktree");

      const files = under(
        loadProjectContextFiles({ cwd: worktree, globalDirs: [] }),
        tempDir
      );

      expect(files.map((file) => file.content)).toStrictEqual([
        "container",
        "worktree",
      ]);
    });
  });

  describe(renderProjectContext, () => {
    test("should return an empty string when there is nothing to render", () => {
      expect(renderProjectContext([])).toBe("");
    });

    test("should wrap every file with its path", () => {
      expect(
        renderProjectContext([
          { path: "/global/AGENTS.md", content: "global" },
          { path: "/repo/AGENTS.md", content: "repo" },
        ])
      ).toBe(
        [
          "Project-specific instructions and guidelines:",
          '<project_instructions path="/global/AGENTS.md">\nglobal\n</project_instructions>',
          '<project_instructions path="/repo/AGENTS.md">\nrepo\n</project_instructions>',
        ].join("\n\n")
      );
    });
  });
});
