/**
 * Assembly-level tests for the asset channel: the real app, the real database, and the
 * real filesystem.
 *
 * They cover the three things the channel promises: an upload lands in the owner's
 * `assets/` directory and records the file name, the byte route versions and headers a
 * response, and malformed requests are stopped before anything is written.
 *
 * `@workspace/db` opens its connection from `DATABASE_URL` at import time, so the
 * database has to be chosen before the module loads: set the variable, then import in
 * `beforeAll`.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

const dir = mkdtempSync(path.join(tmpdir(), "aify-asset-route-"));
process.env.DATABASE_URL = `file:${path.join(dir, "test.db")}`;
process.env.AIFY_DATA_DIR = path.join(dir, "data");

const API_TOKEN = "test-api-token";
const headers = { authorization: `Bearer ${API_TOKEN}` };

/** Only `request` is used, so Hono's environment generic stays out of the test. */
interface TestApp {
  request: (input: string, init?: RequestInit) => Promise<Response> | Response;
}

const BOT_ID = "bot-a";
const SESSION_ID = "s1";

/** A real 1×1 transparent PNG: the shape a reader's upload actually has. */
const PNG_BYTES = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
    "base64"
  )
);

let app: TestApp;

const assetsDirOf = (botId: string): string =>
  path.join(dir, "data", "bots", botId, "assets");

const avatarPathOf = async (botId: string): Promise<string | null> => {
  const { findBotById } = await import("../src/routers/bot/bot.repository");
  const bot = await findBotById(botId);
  return bot?.avatarPath ?? null;
};

const upload = async (input: {
  owner: string;
  name?: string;
  file?: File | string;
}): Promise<Response> => {
  const form = new FormData();
  form.set("owner", input.owner);
  form.set("name", input.name ?? "avatar");
  if (input.file !== undefined) {
    form.set("file", input.file);
  }

  return await app.request("/api/asset", {
    method: "POST",
    body: form,
    headers,
  });
};

const assetUrl = (owner: string, name = "avatar"): string =>
  `/api/asset?owner=${encodeURIComponent(owner)}&name=${name}`;

describe("asset routes", () => {
  beforeAll(async () => {
    const { migrateDb } = await import("@workspace/db");
    await migrateDb();

    const { insertBot } = await import("../src/routers/bot/bot.repository");
    await insertBot({ id: BOT_ID, name: "Aify" });

    const { createApp } = await import("../src/app");
    app = createApp({ apiToken: () => API_TOKEN });
  });

  afterAll(async () => {
    const { closeDb } = await import("@workspace/db");
    closeDb();
    rmSync(dir, { recursive: true, force: true });
  });

  test("refuses a request without a token", async () => {
    const response = await app.request(assetUrl(`bot:${BOT_ID}`));

    expect(response.status).toBe(401);
  });

  test("stores an uploaded image and records the file name", async () => {
    const response = await upload({
      owner: `bot:${BOT_ID}`,
      file: new File([PNG_BYTES], "avatar.png", { type: "image/png" }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      owner: `bot:${BOT_ID}`,
      name: "avatar",
      path: "avatar.png",
    });
    expect(
      existsSync(path.join(assetsDirOf(BOT_ID), "avatar.png"))
    ).toBeTruthy();
    await expect(avatarPathOf(BOT_ID)).resolves.toBe("avatar.png");
  });

  test("redirects an unversioned address to the versioned one", async () => {
    const response = await app.request(assetUrl(`bot:${BOT_ID}`), { headers });

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toMatch(
      /^\/api\/asset\?owner=bot%3Abot-a&name=avatar&v=\d+(%3A|:)\d+$/u
    );
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  test("serves a versioned address with hard cache headers", async () => {
    const redirect = await app.request(assetUrl(`bot:${BOT_ID}`), { headers });
    const response = await app.request(redirect.headers.get("location") ?? "", {
      headers,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toBe(
      "private, max-age=31536000, immutable"
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toBe(
      "sandbox; default-src 'none'"
    );
  });

  test("serves the bytes the upload wrote", async () => {
    const redirect = await app.request(assetUrl(`bot:${BOT_ID}`), { headers });
    const response = await app.request(redirect.headers.get("location") ?? "", {
      headers,
    });

    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(bytes).toStrictEqual(PNG_BYTES);
  });

  test("answers HEAD with the length and no body", async () => {
    const redirect = await app.request(assetUrl(`bot:${BOT_ID}`), { headers });
    const response = await app.request(redirect.headers.get("location") ?? "", {
      method: "HEAD",
      headers,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe(
      String(PNG_BYTES.byteLength)
    );
    await expect(response.text()).resolves.toBe("");
  });

  test("rejects bytes that are not one of the three images", async () => {
    const response = await upload({
      owner: `session:${SESSION_ID}`,
      file: new File(["not an image\n"], "avatar.png", { type: "image/png" }),
    });

    expect(response.status).toBe(415);
    await expect(response.json()).resolves.toStrictEqual({
      error: "unsupported media type",
    });
  });

  test("rejects an image over the limit", async () => {
    const big = new Uint8Array(2 * 1024 * 1024 + 1);
    big.set(PNG_BYTES);

    const response = await upload({
      owner: `bot:${BOT_ID}`,
      file: new File([big], "avatar.png", { type: "image/png" }),
    });

    expect(response.status).toBe(413);
  });

  test("rejects a name that is a path", async () => {
    const response = await upload({
      owner: `bot:${BOT_ID}`,
      name: "../escape",
      file: new File([PNG_BYTES], "avatar.png", { type: "image/png" }),
    });

    expect(response.status).toBe(400);
    expect(
      existsSync(path.join(dir, "data", "bots", "escape.png"))
    ).toBeFalsy();
  });

  test("rejects a malformed owner and an unknown kind", async () => {
    const malformed = await app.request(assetUrl("bot:"), { headers });
    expect(malformed.status).toBe(400);

    const unknownKind = await app.request(assetUrl("project:x"), { headers });
    expect(unknownKind.status).toBe(400);
  });

  test("answers an unknown Bot on every method", async () => {
    const read = await app.request(assetUrl("bot:ghost"), { headers });
    expect(read.status).toBe(404);
    await expect(read.json()).resolves.toStrictEqual({
      error: "owner not found",
    });

    const removed = await app.request(assetUrl("bot:ghost"), {
      method: "DELETE",
      headers,
    });
    expect(removed.status).toBe(404);
  });

  test("serves a session's own asset through the same channel", async () => {
    const response = await upload({
      owner: `session:${SESSION_ID}`,
      file: new File([PNG_BYTES], "avatar.png", { type: "image/png" }),
    });

    expect(response.status).toBe(200);
    expect(
      existsSync(
        path.join(dir, "data", "sessions", SESSION_ID, "assets", "avatar.png")
      )
    ).toBeTruthy();
  });

  test("removes the file and clears the recorded name", async () => {
    const response = await app.request(assetUrl(`bot:${BOT_ID}`), {
      method: "DELETE",
      headers,
    });

    expect(response.status).toBe(204);
    expect(
      existsSync(path.join(assetsDirOf(BOT_ID), "avatar.png"))
    ).toBeFalsy();
    await expect(avatarPathOf(BOT_ID)).resolves.toBeNull();

    // Deleting is idempotent: a second request still succeeds, metadata still empty.
    const again = await app.request(assetUrl(`bot:${BOT_ID}`), {
      method: "DELETE",
      headers,
    });
    expect(again.status).toBe(204);
  });

  test("answers a missing asset with 404", async () => {
    const response = await app.request(assetUrl(`bot:${BOT_ID}`), { headers });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toStrictEqual({
      error: "asset not found",
    });
  });
});
