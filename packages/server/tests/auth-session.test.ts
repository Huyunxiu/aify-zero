/**
 * 登录态与登录票据的装配级测试：真实的 app、真实的数据库、真实的 cookie。
 *
 * `@workspace/db` 在导入时就按 `DATABASE_URL` 建连接，所以选库必须发生在它
 * 被加载之前：先设环境变量，再在 `beforeAll` 里动态导入。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type { AuthStore } from "../src/auth-store";
import type { HonoEnv } from "../src/hono-env";

const dir = mkdtempSync(path.join(tmpdir(), "aify-auth-session-"));
process.env.DATABASE_URL = `file:${path.join(dir, "test.db")}`;

const API_TOKEN = "test-api-token";
const WEB_ORIGIN = "http://127.0.0.1:3000";
const ALLOWED = new Set(["http://localhost", WEB_ORIGIN]);

let app: Hono<HonoEnv>;
let httpsApp: Hono<HonoEnv>;
let previousRun: AuthStore;
let store: AuthStore;

/** 只取 `name=value` 那一段，方便放进下一个请求。 */
const cookieOf = (response: Response): string => {
  const header = response.headers.get("set-cookie") ?? "";

  return header.split(";")[0] ?? "";
};

const login = async (ticket: string): Promise<Response> =>
  await app.request("/api/auth/login", {
    body: JSON.stringify({ ticket }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });

const mintTicket = async (): Promise<string> => {
  const userId = await store.ensureOperator();
  const ticket = await store.createLoginTicket(userId);

  return ticket.token;
};

const statusOf = async (call: Promise<Response>): Promise<number> => {
  const response = await call;

  return response.status;
};

describe("browser sign-in", () => {
  beforeAll(async () => {
    const { migrateDb } = await import("@workspace/db");

    await migrateDb();

    const { createApp } = await import("../src/app");
    const { createAuthStore } = await import("../src/auth-store");

    store = createAuthStore();
    // 换一个 instance，等于“上一次运行”留下的票据。
    previousRun = createAuthStore({ instance: "previous-run" });
    app = createApp({
      trustedOrigins: ALLOWED,
      apiToken: () => API_TOKEN,
      authStore: store,
      env: { AIFY_WEB_ORIGIN: WEB_ORIGIN },
      webRoot: null,
    });
    httpsApp = createApp({
      trustedOrigins: new Set(["https://aify.example.com"]),
      apiToken: () => API_TOKEN,
      authStore: store,
      env: { AIFY_PUBLIC_ORIGIN: "https://aify.example.com" },
      webRoot: null,
    });
  });

  afterAll(() => {
    rmSync(dir, { force: true, recursive: true });
  });

  test("reports no sign-in without credentials", async () => {
    const response = await app.request("/api/auth/session");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({
      authenticated: false,
    });
  });

  test("reports sign-in when the access token is present", async () => {
    const response = await app.request("/api/auth/session", {
      headers: { authorization: `Bearer ${API_TOKEN}` },
    });

    await expect(response.json()).resolves.toStrictEqual({
      authenticated: true,
    });
  });

  test("exchanges a ticket for an HttpOnly cookie", async () => {
    const response = await login(await mintTicket());

    expect(response.status).toBe(204);

    const setCookie = response.headers.get("set-cookie") ?? "";

    expect(setCookie).toContain("aify_session=");
    expect(setCookie).toContain("HttpOnly");
  });

  test("keeps the cookie usable on plain http", async () => {
    const response = await login(await mintTicket());
    const setCookie = response.headers.get("set-cookie") ?? "";

    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain("Path=/");
    // 局域网 http 必须不带 Secure，否则浏览器直接丢弃 cookie。
    expect(setCookie).not.toContain("Secure");
  });

  test("the cookie authenticates API calls and slides its lifetime", async () => {
    const cookie = cookieOf(await login(await mintTicket()));
    const response = await app.request("/health", { headers: { cookie } });

    expect(response.status).toBe(200);
    // 数据库里的到期时间滑动，浏览器手里那份也要跟着换，否则第 30 天还是掉线。
    expect(response.headers.get("set-cookie")).toContain("aify_session=");
  });

  test("a ticket keeps working until the next restart", async () => {
    const ticket = await mintTicket();

    await expect(statusOf(login(ticket))).resolves.toBe(204);
    await expect(statusOf(login(ticket))).resolves.toBe(204);
  });

  test("a ticket from a previous run is refused", async () => {
    const userId = await previousRun.ensureOperator();
    const ticket = await previousRun.createLoginTicket(userId);
    const response = await login(ticket.token);

    expect(response.status).toBe(401);
  });

  test("renews the cookie on a session probe", async () => {
    const cookie = cookieOf(await login(await mintTicket()));
    const response = await app.request("/api/auth/session", {
      headers: { cookie },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("aify_session=");
  });

  test("rejects a cross-site origin on the session probe", async () => {
    const cookie = cookieOf(await login(await mintTicket()));
    const response = await app.request("/api/auth/session", {
      headers: { cookie, origin: "https://evil.example" },
    });

    expect(response.status).toBe(403);
  });

  test("rejects a cross-site origin that carries the cookie", async () => {
    const cookie = cookieOf(await login(await mintTicket()));
    const response = await app.request("/health", {
      headers: { cookie, origin: "https://evil.example" },
    });

    expect(response.status).toBe(403);
  });

  test("rejects a cross-site fetch metadata even without an origin", async () => {
    const cookie = cookieOf(await login(await mintTicket()));
    const response = await app.request("/health", {
      headers: { cookie, "sec-fetch-site": "cross-site" },
    });

    expect(response.status).toBe(403);
  });

  test("logout drops the session", async () => {
    const cookie = cookieOf(await login(await mintTicket()));

    const logout = await app.request("/api/auth/logout", {
      headers: { cookie },
      method: "POST",
    });

    expect(logout.status).toBe(204);

    const after = await app.request("/health", { headers: { cookie } });

    expect(after.status).toBe(401);
  });

  test("mints a login link for another device", async () => {
    const response = await app.request("/api/auth/login-link", {
      headers: { authorization: `Bearer ${API_TOKEN}` },
      method: "POST",
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { url: string };

    expect(body.url).toContain("?token=");
    expect(body.url.startsWith(WEB_ORIGIN)).toBeTruthy();
  });

  test("does not mint a link without credentials", async () => {
    const response = await app.request("/api/auth/login-link", {
      method: "POST",
    });

    expect(response.status).toBe(401);
  });

  test("marks the cookie Secure when the deployment is https", async () => {
    const userId = await store.ensureOperator();
    const ticket = await store.createLoginTicket(userId);
    const response = await httpsApp.request("/api/auth/login", {
      body: JSON.stringify({ ticket: ticket.token }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    expect(response.headers.get("set-cookie")).toContain("Secure");
  });
});
