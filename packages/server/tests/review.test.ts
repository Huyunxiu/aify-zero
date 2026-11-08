/**
 * 改动视图读模型的测试。
 *
 * 用临时真仓库，不碰数据库：根由测试直接构造。这里覆盖的是真正有风险的部分
 * ——porcelain v2 的解析、主目录落在仓库子目录时的过滤、基线一侧的取法，以及
 * 「不是仓库」「不是文本」「超出上限」这三种按结果返回的状态。
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  readReviewChanges,
  readReviewFile,
} from "../src/routers/review/review.service";
import { DEFAULT_LIMITS } from "../src/routers/workspace/workspace.files";
import type { WorkspaceRoots } from "../src/routers/workspace/workspace.paths";

const exec = promisify(execFile);

/** 测试用的 git 身份与配置：不读用户配置，也不依赖本机设置。 */
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_AUTHOR_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};

async function git(dir: string, ...args: readonly string[]): Promise<void> {
  await exec("git", [...args], { cwd: dir, env: GIT_ENV });
}

async function initRepo(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await git(dir, "init", "--quiet");
  await git(dir, "config", "user.email", "test@example.com");
  await git(dir, "config", "user.name", "Test");
}

/** 提交当前内容；`-A` 让删除和新增一起进。 */
async function commitAll(dir: string, message: string): Promise<void> {
  await git(dir, "add", "-A");
  await git(dir, "commit", "--quiet", "-m", message);
}

function workspaceOf(primaryDir: string): WorkspaceRoots {
  return { primaryDir, roots: [primaryDir] };
}

/** 改动列表；不是仓库时让用例直接失败，省掉每个用例的收窄。 */
async function changesOf(workspace: WorkspaceRoots) {
  const result = await readReviewChanges(workspace);

  if (result.kind !== "changes") {
    throw new Error(`expected changes, got ${result.reason}`);
  }

  return result;
}

/** 一个改动的两侧文本；被拒绝时让用例直接失败。 */
async function fileOf(workspace: WorkspaceRoots, path: string) {
  const result = await readReviewFile(workspace, path);

  if (result.kind !== "file") {
    throw new Error(`expected a file, got ${result.kind}`);
  }

  return result;
}

let base: string;

describe("review", () => {
  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), "aify-review-"));
  });

  afterAll(async () => {
    await rm(base, { recursive: true, force: true });
  });

  describe("review changes", () => {
    let repo: string;
    let workspace: WorkspaceRoots;

    beforeAll(async () => {
      repo = join(base, "repo");
      await initRepo(repo);

      await writeFile(join(repo, "modified.txt"), "one\ntwo\n");
      await writeFile(join(repo, "staged.txt"), "staged\n");
      await writeFile(join(repo, "deleted.txt"), "gone\n");
      await writeFile(join(repo, "renamed.txt"), "same\n");
      await writeFile(join(repo, "old-name.txt"), "content\n");
      await mkdir(join(repo, "src"), { recursive: true });
      await writeFile(join(repo, "src", "kept.txt"), "kept\n");
      await writeFile(join(repo, ".gitignore"), "ignored.txt\n");
      await commitAll(repo, "init");

      await writeFile(join(repo, "modified.txt"), "one\ntwo\nthree\n");
      await writeFile(join(repo, "staged.txt"), "staged\nmore\n");
      await git(repo, "add", "staged.txt");
      await rm(join(repo, "deleted.txt"));
      // 纯重命名：内容不变。走索引，git 才认得出是重命名。
      await git(repo, "mv", "renamed.txt", "renamed-2.txt");
      // 带内容变化的重命名。
      await git(repo, "mv", "old-name.txt", "new-name.txt");
      await writeFile(join(repo, "new-name.txt"), "content\nchanged\n");
      await writeFile(join(repo, "untracked.txt"), "fresh\n");
      // 路径里的连续空格要原样保留：porcelain 记录是按空格分字段的。
      await writeFile(join(repo, "two  spaces.txt"), "x\n");
      await writeFile(join(repo, "ignored.txt"), "ignored\n");

      workspace = workspaceOf(repo);
    });

    test("lists every changed path with its status", async () => {
      const { changes, hasHead } = await changesOf(workspace);
      const byPath = new Map(changes.map((change) => [change.path, change]));

      expect(hasHead).toBeTruthy();
      expect(byPath.get("modified.txt")?.status).toBe("modified");
      // 已暂存的改动同样算：基线是 HEAD，不是索引。
      expect(byPath.get("staged.txt")?.status).toBe("modified");
      expect(byPath.get("deleted.txt")?.status).toBe("deleted");
      expect(byPath.get("untracked.txt")?.status).toBe("untracked");
    });

    test("keeps the old path of a rename", async () => {
      const { changes } = await changesOf(workspace);
      const byPath = new Map(changes.map((change) => [change.path, change]));

      expect(byPath.get("renamed-2.txt")?.status).toBe("renamed");
      expect(byPath.get("renamed-2.txt")?.oldPath).toBe("renamed.txt");
      expect(byPath.get("new-name.txt")?.oldPath).toBe("old-name.txt");
    });

    test("names the workspace root", async () => {
      const { rootName } = await changesOf(workspace);

      expect(rootName).toBe("repo");
    });

    test("keeps spaces inside a path", async () => {
      const { changes } = await changesOf(workspace);

      expect(
        changes.some((change) => change.path === "two  spaces.txt")
      ).toBeTruthy();
    });

    test("does not list ignored paths", async () => {
      const { changes } = await changesOf(workspace);

      expect(
        changes.some((change) => change.path === "ignored.txt")
      ).toBeFalsy();
    });

    test("keeps the baseline text for a modification", async () => {
      const file = await fileOf(workspace, "modified.txt");

      expect(file.oldText).toBe("one\ntwo\n");
      expect(file.newText).toBe("one\ntwo\nthree\n");
    });

    test("has no baseline text for an untracked file", async () => {
      const file = await fileOf(workspace, "untracked.txt");

      expect(file.status).toBe("untracked");
      expect(file.oldText).toBeNull();
      expect(file.newText).toBe("fresh\n");
    });

    test("has no working-tree text for a deleted file", async () => {
      const file = await fileOf(workspace, "deleted.txt");

      expect(file.status).toBe("deleted");
      expect(file.oldText).toBe("gone\n");
      expect(file.newText).toBeNull();
    });

    test("reads a pure rename from both of its paths", async () => {
      const pure = await fileOf(workspace, "renamed-2.txt");

      expect(pure.oldPath).toBe("renamed.txt");
      expect(pure.oldText).toBe("same\n");
      expect(pure.newText).toBe("same\n");
    });

    test("reads a rename that also changed the content", async () => {
      const changed = await fileOf(workspace, "new-name.txt");

      expect(changed.oldPath).toBe("old-name.txt");
      expect(changed.oldText).toBe("content\n");
      expect(changed.newText).toBe("content\nchanged\n");
    });

    test("falls back to a modification for a path that is not listed", async () => {
      const file = await fileOf(workspace, "src/kept.txt");

      expect(file.status).toBe("modified");
      expect(file.oldText).toBe("kept\n");
      expect(file.newText).toBe("kept\n");
    });

    test("rejects a path that leaves the workspace", async () => {
      await expect(readReviewFile(workspace, "../outside.txt")).rejects.toThrow(
        "path must be relative to the workspace root"
      );
      await expect(readReviewFile(workspace, "/etc/passwd")).rejects.toThrow(
        "path must be relative to the workspace root"
      );
    });
  });

  describe("review changes from a subdirectory of the repository", () => {
    let repo: string;
    let workspace: WorkspaceRoots;

    beforeAll(async () => {
      repo = join(base, "monorepo");
      await initRepo(repo);

      await mkdir(join(repo, "pkg", "src"), { recursive: true });
      await mkdir(join(repo, "other"), { recursive: true });
      await writeFile(join(repo, "pkg", "src", "a.ts"), "a\n");
      await writeFile(join(repo, "pkg", "b.ts"), "b\n");
      await writeFile(join(repo, "other", "c.ts"), "c\n");
      await commitAll(repo, "init");

      await writeFile(join(repo, "pkg", "src", "a.ts"), "a\nchanged\n");
      await writeFile(join(repo, "other", "c.ts"), "c\nchanged\n");

      workspace = workspaceOf(join(repo, "pkg"));

      // 重命名在两个目录之间移动时，旧路径在工作区外：对主目录来说是新增。
      await git(repo, "mv", "pkg/b.ts", "other/d.ts");
    });

    test("only lists paths inside the primary directory", async () => {
      const { changes } = await changesOf(workspace);

      expect(changes.map((change) => change.path).toSorted()).toStrictEqual([
        "b.ts",
        "src/a.ts",
      ]);
    });

    test("reports a path that moved out of the workspace as deleted", async () => {
      const { changes } = await changesOf(workspace);
      const moved = changes.find((change) => change.path === "b.ts");

      expect(moved?.status).toBe("deleted");
      expect(moved?.oldPath).toBeUndefined();
    });

    test("reads a baseline that lives above the primary directory", async () => {
      const file = await fileOf(workspace, "src/a.ts");

      expect(file.oldText).toBe("a\n");
      expect(file.newText).toBe("a\nchanged\n");
    });
  });

  describe("review changes in a repository without a commit", () => {
    let repo: string;
    let workspace: WorkspaceRoots;

    beforeAll(async () => {
      repo = join(base, "fresh");
      await initRepo(repo);
      await writeFile(join(repo, "first.txt"), "first\n");
      await writeFile(join(repo, "staged.txt"), "staged\n");
      await git(repo, "add", "staged.txt");

      workspace = workspaceOf(repo);
    });

    test("uses the empty tree as the baseline", async () => {
      const { changes, hasHead } = await changesOf(workspace);
      const byPath = new Map(changes.map((change) => [change.path, change]));

      expect(hasHead).toBeFalsy();
      expect(byPath.get("first.txt")?.status).toBe("untracked");
      expect(byPath.get("staged.txt")?.status).toBe("added");

      const file = await fileOf(workspace, "staged.txt");

      expect(file.oldText).toBeNull();
      expect(file.newText).toBe("staged\n");
    });
  });

  describe("review changes that cannot be shown as text", () => {
    let repo: string;
    let workspace: WorkspaceRoots;

    beforeAll(async () => {
      repo = join(base, "cases");
      await initRepo(repo);
      // 先提交一份超大文件，再删掉它：基线一侧的大小要能挡住读取。
      await writeFile(
        join(repo, "old-large.txt"),
        "x".repeat(DEFAULT_LIMITS.maxBytes + 1)
      );
      await commitAll(repo, "large");
      await rm(join(repo, "old-large.txt"));
      await writeFile(join(repo, "bin.dat"), Buffer.from([0xff, 0x00, 0x01]));
      await writeFile(
        join(repo, "large.txt"),
        "x".repeat(DEFAULT_LIMITS.maxBytes + 1)
      );

      workspace = workspaceOf(repo);
    });

    test("refuses a deleted file whose baseline side is too large", async () => {
      const result = await readReviewFile(workspace, "old-large.txt");

      expect(result).toStrictEqual({
        kind: "refused",
        path: "old-large.txt",
        reason: "too-large",
      });
    });

    test("refuses a binary file", async () => {
      const result = await readReviewFile(workspace, "bin.dat");

      expect(result).toStrictEqual({
        kind: "refused",
        path: "bin.dat",
        reason: "binary",
      });
    });

    test("refuses a file above the size limit", async () => {
      const result = await readReviewFile(workspace, "large.txt");

      expect(result).toStrictEqual({
        kind: "refused",
        path: "large.txt",
        reason: "too-large",
      });
    });
  });

  describe("review changes in a conflicted merge", () => {
    let repo: string;
    let workspace: WorkspaceRoots;

    beforeAll(async () => {
      repo = join(base, "conflicted");
      await initRepo(repo);
      await writeFile(join(repo, "conflict.txt"), "base\n");
      await commitAll(repo, "base");

      await git(repo, "checkout", "--quiet", "-b", "other");
      await writeFile(join(repo, "conflict.txt"), "other\n");
      await commitAll(repo, "other");

      await git(repo, "checkout", "--quiet", "-");
      await writeFile(join(repo, "conflict.txt"), "main\n");
      await commitAll(repo, "main");

      // 合并停在冲突上：status 会出现 unmerged 记录。
      await git(repo, "merge", "other").catch(() => {});

      workspace = workspaceOf(repo);
    });

    test("the repository really has an unmerged record", async () => {
      const { stdout } = await exec("git", ["status", "--porcelain=v2"], {
        cwd: repo,
        env: GIT_ENV,
      });

      expect(stdout).toMatch(/^u /m);
    });

    test("keeps a conflicted path in the list", async () => {
      const { changes } = await changesOf(workspace);
      const conflicted = changes.find(
        (change) => change.path === "conflict.txt"
      );

      expect(conflicted?.status).toBe("modified");
    });
  });

  describe("review changes outside a repository", () => {
    test("reports that the directory is not a repository", async () => {
      const dir = join(base, "plain");
      await mkdir(dir, { recursive: true });

      const result = await readReviewChanges(workspaceOf(dir));

      expect(result).toStrictEqual({
        kind: "unsupported",
        reason: "not-a-repository",
      });
    });
  });
});
