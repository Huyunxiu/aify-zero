/**
 * 工作区文件接口的测试。
 *
 * 不碰数据库：根由测试直接构造，覆盖路径闸门、列举、分页切行和字节路由
 * 这些真正有风险的部分。会话到根的解析在路由层，由应用装配时注入。
 */
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { serveWorkspaceFile } from "../src/routers/workspace/workspace.file-route";
import {
  DEFAULT_LIMITS,
  listEntries,
  readFileBytes,
  readTextPage,
  statWorkspaceFile,
} from "../src/routers/workspace/workspace.files";
import type {
  WorkspaceReadOptions,
  WorkspaceTextRange,
} from "../src/routers/workspace/workspace.files";
import type { WorkspaceRoots } from "../src/routers/workspace/workspace.paths";

let dir: string;
let root: string;
let workspace: WorkspaceRoots;

/** 一条指向字节路由的请求；查询参数由调用方拼。 */
const fileRequest = (query: string, method = "GET"): Request =>
  new Request(`http://local/api/workspace/file?${query}`, { method });

/** 读一页并确认成功：下面几个用例要的是页内容，不是拒绝原因。 */
async function readPage(
  path: string,
  range: WorkspaceTextRange,
  options: WorkspaceReadOptions = {}
) {
  const result = await readTextPage(workspace, path, range, options);
  if (result.kind !== "text") {
    throw new Error(`expected a page, got ${result.reason}`);
  }
  return result;
}

describe("workspace files", () => {
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "aify-workspace-"));
    root = join(dir, "root");

    await mkdir(join(root, "sub"), { recursive: true });
    await mkdir(join(dir, "outside"), { recursive: true });

    await writeFile(join(root, "a.txt"), "one\ntwo\nthree\n");
    await writeFile(join(root, "empty.txt"), "");
    await writeFile(join(root, "sub", "b.md"), "# b\n");
    await writeFile(join(root, ".hidden"), "hidden\n");
    await writeFile(join(root, "long.txt"), "x".repeat(100));
    // 0xFF 0xFE 是非法 UTF-8 序列。
    await writeFile(join(root, "bin.dat"), Buffer.from([0xff, 0xfe, 0x00]));
    await writeFile(join(root, "nul.txt"), `a${String.fromCodePoint(0)}b\n`);
    await writeFile(join(dir, "outside", "secret.txt"), "secret\n");

    await symlink(join(dir, "outside", "secret.txt"), join(root, "link-out"));
    await symlink(join(root, "sub"), join(root, "link-in"));
    await symlink(join(root, "a.txt"), join(root, "link-file"));

    workspace = { primaryDir: root, roots: [root] };
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  describe(listEntries, () => {
    test("lists direct children", async () => {
      const listing = await listEntries(workspace, ".");

      expect(listing.path).toBe("");
      // 根标题用主目录的名字。
      expect(listing.rootName).toBe("root");
      const names = listing.entries.map((entry) => entry.name);
      expect(names).toContain("sub");
      expect(names).toContain("a.txt");
      // dotfiles 与普通条目一样列出。
      expect(names).toContain(".hidden");
    });

    test("puts every directory before every file", async () => {
      const listing = await listEntries(workspace, ".");

      const firstFile = listing.entries.findIndex(
        (entry) => entry.type !== "directory"
      );
      const lastDirectory = listing.entries.findLastIndex(
        (entry) => entry.type === "directory"
      );

      expect(lastDirectory).toBeLessThan(firstFile);
      expect(listing.truncated).toBeFalsy();
    });

    test("reports a symlink by the type of its target", async () => {
      const listing = await listEntries(workspace, ".");

      expect(
        listing.entries.find((entry) => entry.name === "link-in")?.type
      ).toBe("directory");
      expect(
        listing.entries.find((entry) => entry.name === "link-out")?.type
      ).toBe("file");
    });

    test("lists a subdirectory by its workspace path", async () => {
      const listing = await listEntries(workspace, "sub");

      expect(listing.path).toBe("sub");
      expect(listing.entries.map((entry) => entry.name)).toStrictEqual([
        "b.md",
      ]);
    });

    test("cuts the listing at the entry cap", async () => {
      const listing = await listEntries(workspace, ".", {
        limits: { ...DEFAULT_LIMITS, maxEntries: 2 },
      });

      expect(listing.entries).toHaveLength(2);
      expect(listing.truncated).toBeTruthy();
    });

    test("refuses a file", async () => {
      await expect(listEntries(workspace, "a.txt")).rejects.toMatchObject({
        code: "WORKSPACE_NOT_DIRECTORY",
        data: { path: "a.txt", kind: "file" },
      });
    });

    test("refuses a path outside the workspace", async () => {
      await expect(
        listEntries(workspace, join(dir, "outside"))
      ).rejects.toMatchObject({ code: "WORKSPACE_OUTSIDE" });
    });

    test("refuses a link that escapes the workspace", async () => {
      await expect(listEntries(workspace, "link-out")).rejects.toMatchObject({
        code: "WORKSPACE_OUTSIDE",
      });
    });
  });

  describe(readTextPage, () => {
    test("reads the first page and stops before the last line", async () => {
      const page = await readPage("a.txt", {
        offset: 1,
        limit: 2,
      });

      expect(page.text).toBe("one\ntwo");
      expect(page.lines).toBe(2);
      expect(page.eof).toBeFalsy();
      expect(page.offset).toBe(1);
    });

    test("reaches eof on the page that holds the last line", async () => {
      const page = await readPage("a.txt", {
        offset: 2,
        limit: 2,
      });

      expect(page.text).toBe("two\nthree");
      expect(page.eof).toBeTruthy();
    });

    test("returns an empty page past the last line", async () => {
      const page = await readPage("a.txt", { offset: 99 });

      expect(page.text).toBe("");
      expect(page.lines).toBe(0);
      expect(page.eof).toBeTruthy();
    });

    test("an empty file has no lines", async () => {
      const page = await readPage("empty.txt", {});

      expect(page.lines).toBe(0);
      expect(page.text).toBe("");
      expect(page.eof).toBeTruthy();
    });

    test("reports invalid UTF-8 instead of throwing", async () => {
      await expect(
        readTextPage(workspace, "bin.dat", {})
      ).resolves.toStrictEqual({
        kind: "refused",
        path: "bin.dat",
        reason: "not-text",
      });
    });

    test("reports NUL bytes instead of throwing", async () => {
      await expect(
        readTextPage(workspace, "nul.txt", {})
      ).resolves.toStrictEqual({
        kind: "refused",
        path: "nul.txt",
        reason: "not-text",
      });
    });

    test("reports a page above the byte cap instead of truncating it", async () => {
      await expect(
        readTextPage(
          workspace,
          "long.txt",
          {},
          {
            limits: { ...DEFAULT_LIMITS, maxBytes: 50 },
          }
        )
      ).resolves.toStrictEqual({
        kind: "refused",
        path: "long.txt",
        reason: "too-large",
      });
    });

    test("reports a directory instead of throwing", async () => {
      await expect(readTextPage(workspace, "sub", {})).resolves.toStrictEqual({
        kind: "refused",
        path: "sub",
        reason: "not-regular-file",
      });
    });

    test("follows an intermediate directory link inside the workspace", async () => {
      const page = await readPage("link-in/b.md", {});

      expect(page.text).toBe("# b");
    });

    test("follows a final symlink to a file inside the workspace", async () => {
      const page = await readPage("link-file", {});

      expect(page.text).toBe("one\ntwo\nthree");
      // 返回的路径是链接目标，不是链接本身。
      expect(page.absolutePath).toContain(root);
      expect(page.absolutePath.endsWith("a.txt")).toBeTruthy();
    });

    test("reports a final symlink to a directory instead of throwing", async () => {
      await expect(
        readTextPage(workspace, "link-in", {})
      ).resolves.toStrictEqual({
        kind: "refused",
        path: "link-in",
        reason: "not-regular-file",
      });
    });

    test("refuses a final symlink that escapes the workspace", async () => {
      await expect(
        readTextPage(workspace, "link-out", {})
      ).rejects.toMatchObject({ code: "WORKSPACE_OUTSIDE" });
    });
  });

  describe(statWorkspaceFile, () => {
    test("changes the version when the content changes", async () => {
      const before = await statWorkspaceFile(workspace, "a.txt");

      await writeFile(join(root, "a.txt"), "one\ntwo\nthree\nfour\n");
      const after = await statWorkspaceFile(workspace, "a.txt");

      expect(after.version).not.toBe(before.version);
      expect(after.bytes).toBe(before.bytes + "four\n".length);
    });

    test("reports the target of a final symlink", async () => {
      const link = await statWorkspaceFile(workspace, "link-file");
      const target = await statWorkspaceFile(workspace, "a.txt");

      expect(link.absolutePath).toBe(target.absolutePath);
      expect(link.version).toBe(target.version);
      expect(link.bytes).toBe(target.bytes);
    });

    test("refuses a missing path", async () => {
      await expect(
        statWorkspaceFile(workspace, "missing.txt")
      ).rejects.toMatchObject({ code: "WORKSPACE_NOT_FOUND" });
    });
  });

  describe(readFileBytes, () => {
    test("reads complete bytes without decoding", async () => {
      const file = await readFileBytes(workspace, "bin.dat");

      expect([...file.data]).toStrictEqual([0xff, 0xfe, 0x00]);
    });

    test("reads the bytes of a final symlink", async () => {
      const link = await readFileBytes(workspace, "link-file");
      const target = await readFileBytes(workspace, "a.txt");

      expect([...link.data]).toStrictEqual([...target.data]);
    });

    test("refuses a file above the cap", async () => {
      await expect(
        readFileBytes(workspace, "bin.dat", {
          limits: { ...DEFAULT_LIMITS, maxFileBytes: 2 },
        })
      ).rejects.toMatchObject({
        code: "WORKSPACE_TOO_LARGE",
        data: { path: "bin.dat", limit: 2 },
      });
    });
  });

  describe(serveWorkspaceFile, () => {
    const deps = { resolveRoots: () => Promise.resolve(workspace) };

    test("redirects a versionless request to the versioned address", async () => {
      const response = await serveWorkspaceFile(
        fileRequest("sessionId=s1&path=a.txt"),
        deps
      );
      const stat = await statWorkspaceFile(workspace, "a.txt");

      expect(response.status).toBe(302);
      expect(response.headers.get("cache-control")).toContain("no-store");
      const location = new URL(
        response.headers.get("location") ?? "",
        "http://x"
      );
      expect(location.searchParams.get("v")).toBe(stat.version);
    });

    test("serves the file at the versioned address", async () => {
      const stat = await statWorkspaceFile(workspace, "a.txt");
      const response = await serveWorkspaceFile(
        fileRequest(
          `sessionId=s1&path=a.txt&v=${encodeURIComponent(stat.version)}`
        ),
        deps
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/plain");
      expect(response.headers.get("cache-control")).toContain("immutable");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      await expect(response.text()).resolves.toBe("one\ntwo\nthree\nfour\n");
    });

    test("serves a file through a final symlink", async () => {
      const stat = await statWorkspaceFile(workspace, "link-file");
      const response = await serveWorkspaceFile(
        fileRequest(
          `sessionId=s1&path=link-file&v=${encodeURIComponent(stat.version)}`
        ),
        deps
      );

      expect(response.status).toBe(200);
      // 版本和内容都来自链接目标，链接本身的大小不参与。
      await expect(response.text()).resolves.toBe("one\ntwo\nthree\nfour\n");
    });

    test("answers HEAD without a body", async () => {
      const stat = await statWorkspaceFile(workspace, "a.txt");
      const response = await serveWorkspaceFile(
        fileRequest(
          `sessionId=s1&path=a.txt&v=${encodeURIComponent(stat.version)}`,
          "HEAD"
        ),
        deps
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("content-length")).toBe(String(stat.bytes));
      await expect(response.text()).resolves.toBe("");
    });

    test("answers a missing parameter with 400", async () => {
      const response = await serveWorkspaceFile(
        fileRequest("sessionId=s1"),
        deps
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toStrictEqual({
        error: "missing sessionId or path",
      });
    });

    test("answers an outside path with the error code", async () => {
      const outside = join(dir, "outside", "secret.txt");
      const response = await serveWorkspaceFile(
        fileRequest(`sessionId=s1&path=${encodeURIComponent(outside)}`),
        deps
      );

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toStrictEqual({
        error: "WORKSPACE_OUTSIDE",
      });
    });

    test("answers a non-regular file with the error code", async () => {
      const response = await serveWorkspaceFile(
        fileRequest("sessionId=s1&path=sub"),
        deps
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toStrictEqual({
        error: "WORKSPACE_NOT_REGULAR_FILE",
      });
    });
  });
});
