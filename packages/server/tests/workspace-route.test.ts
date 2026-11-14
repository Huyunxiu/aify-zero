/**
 * 工作区接口的装配级测试：走真实的 app、真实的数据库和真实的文件系统。
 *
 * 覆盖单元测试覆盖不到的部分：oRPC 路由是否挂在 `appRouter` 上、GET 查询
 * 参数是否被 schema 正确强转、文件路由是否在 oRPC 兜底之前生效、鉴权是否
 * 同样拦得住它。
 *
 * `@workspace/db` 在导入时就按 `DATABASE_URL` 建连接，所以选库必须发生在它
 * 被加载之前：先设环境变量，再在 `beforeAll` 里动态导入。
 */
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

const dir = mkdtempSync(path.join(tmpdir(), "aify-workspace-route-"));
process.env.DATABASE_URL = `file:${path.join(dir, "test.db")}`;

const API_TOKEN = "test-api-token";
const headers = { authorization: `Bearer ${API_TOKEN}` };

/** 只用到 `request`，不必把 Hono 的环境泛型拖进来。 */
interface TestApp {
  request: (input: string, init?: RequestInit) => Promise<Response> | Response;
}

let app: TestApp;
let root: string;

/** 调一条 OpenAPI 路由，避开 RPC 的请求体编码。 */
const openapi = async (pathAndQuery: string): Promise<Response> =>
  await app.request(`/api/openapi${pathAndQuery}`, { headers });

describe("workspace routes", () => {
  beforeAll(async () => {
    root = path.join(dir, "project");
    mkdirSync(path.join(root, "sub"), { recursive: true });
    writeFileSync(path.join(root, "hello.txt"), "hello\nworld\n");
    // 常见写法：CLAUDE.md 是指向 AGENTS.md 的链接。
    writeFileSync(path.join(root, "AGENTS.md"), "agents\n");
    symlinkSync(path.join(root, "AGENTS.md"), path.join(root, "CLAUDE.md"));
    writeFileSync(path.join(dir, "outside.txt"), "outside\n");

    const { migrateDb } = await import("@workspace/db");
    await migrateDb();

    const { createProject } =
      await import("../src/routers/project/project.repository");
    const project = await createProject({
      name: "Workspace",
      primaryDir: root,
      additionalDirs: [],
    });
    const { SQLiteStore } = await import("../src/storage/sqlite-store");
    await new SQLiteStore().saveSession({
      id: "s1",
      title: "Workspace",
      metadata: {},
      projectId: project?.id ?? null,
    });

    const { createApp } = await import("../src/app");
    app = createApp({ apiToken: () => API_TOKEN });
  });

  afterAll(async () => {
    const { closeDb } = await import("@workspace/db");
    closeDb();
    rmSync(dir, { recursive: true, force: true });
  });

  test("lists entries over the OpenAPI surface", async () => {
    const response = await openapi("/workspace/entries?sessionId=s1&path=.");
    const body = (await response.json()) as {
      path: string;
      entries: { name: string }[];
    };

    expect(response.status).toBe(200);
    expect(body.path).toBe("");
    expect(body.entries.map((entry) => entry.name)).toStrictEqual(
      expect.arrayContaining(["hello.txt", "sub"])
    );
  });

  test("reads one page with numeric query parameters", async () => {
    const response = await openapi(
      "/workspace/read?sessionId=s1&path=hello.txt&offset=2&limit=1"
    );
    const body = (await response.json()) as {
      kind: string;
      text: string;
      lines: number;
      eof: boolean;
      offset: number;
    };

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      kind: "text",
      text: "world",
      lines: 1,
      offset: 2,
    });
    expect(body.eof).toBeTruthy();
  });

  test("reads a linked file such as CLAUDE.md", async () => {
    const response = await openapi(
      "/workspace/read?sessionId=s1&path=CLAUDE.md"
    );
    const body = (await response.json()) as {
      text: string;
      absolutePath: string;
      bytes: number;
    };

    expect(response.status).toBe(200);
    expect(body.text).toBe("agents");
    expect(body.bytes).toBe("agents\n".length);
    // 响应指向链接目标，界面按真实文件展示。
    expect(
      body.absolutePath.endsWith(path.join("project", "AGENTS.md"))
    ).toBeTruthy();
  });

  test("answers stat with a version", async () => {
    const response = await openapi(
      "/workspace/stat?sessionId=s1&path=hello.txt"
    );
    const body = (await response.json()) as { version: string; bytes: number };

    expect(response.status).toBe(200);
    expect(body.version).toStrictEqual(expect.any(String));
    expect(body.bytes).toBe("hello\nworld\n".length);
  });

  test("answers an unknown session with the typed error", async () => {
    const response = await openapi("/workspace/entries?sessionId=nope&path=.");
    const body = (await response.json()) as { code: string };

    expect(response.status).toBe(404);
    expect(body.code).toBe("SESSION_NOT_FOUND");
  });

  test("protects the file route with the same bearer token", async () => {
    const response = await app.request(
      "/api/workspace/file?sessionId=s1&path=hello.txt"
    );

    expect(response.status).toBe(401);
  });

  test("serves the file route with a redirect then the bytes", async () => {
    const statResponse = await openapi(
      "/workspace/stat?sessionId=s1&path=hello.txt"
    );
    const stat = (await statResponse.json()) as { version: string };

    const redirect = await app.request(
      "/api/workspace/file?sessionId=s1&path=hello.txt",
      { headers }
    );
    expect(redirect.status).toBe(302);
    const location = redirect.headers.get("location") ?? "";
    expect(location).toContain(`v=${encodeURIComponent(stat.version)}`);

    const served = await app.request(location, { headers });
    expect(served.status).toBe(200);
    await expect(served.text()).resolves.toBe("hello\nworld\n");
  });

  test("refuses a file outside the project", async () => {
    const outside = path.join(dir, "outside.txt");
    const response = await app.request(
      `/api/workspace/file?sessionId=s1&path=${encodeURIComponent(outside)}`,
      { headers }
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toStrictEqual({
      error: "WORKSPACE_OUTSIDE",
    });
  });
});
