/**
 * Assembly-level tests for the attachment byte channel: the real app and the real
 * filesystem.
 *
 * The channel promises three things: one address per immutable object, the media type
 * from the bytes, and a cache header that never has to be invalidated. It also promises
 * that an address cannot leave the owner's directory.
 *
 * `@workspace/db` opens its connection from `DATABASE_URL` at import time, so the
 * database has to be chosen before the module loads: set the variable, then import in
 * `beforeAll`.
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

const dir = mkdtempSync(path.join(tmpdir(), "aify-attachment-route-"));
process.env.DATABASE_URL = `file:${path.join(dir, "test.db")}`;
process.env.AIFY_DATA_DIR = path.join(dir, "data");

const API_TOKEN = "test-api-token";
const headers = { authorization: `Bearer ${API_TOKEN}` };

interface TestApp {
  request: (input: string, init?: RequestInit) => Promise<Response> | Response;
}

const SESSION_ID = "s1";

/** A real 1×1 PNG, so the media type comes from the bytes and not from a name. */
const PNG_BYTES = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
    "base64"
  )
);

const digestOf = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

const sha = digestOf(PNG_BYTES);

const attachmentUrl = (input: { owner?: string; sha256?: string }): string =>
  `/api/attachment?owner=${encodeURIComponent(input.owner ?? `session:${SESSION_ID}`)}&sha256=${input.sha256 ?? sha}`;

let app: TestApp;

describe("attachment route", () => {
  beforeAll(async () => {
    const { migrateDb } = await import("@workspace/db");
    await migrateDb();

    const objectPath = path.join(
      dir,
      "data",
      "sessions",
      SESSION_ID,
      "attachments",
      sha
    );
    mkdirSync(path.dirname(objectPath), { recursive: true });
    writeFileSync(objectPath, PNG_BYTES);

    const { createApp } = await import("../src/app");
    app = createApp({ apiToken: () => API_TOKEN });
  });

  afterAll(async () => {
    const { closeDb } = await import("@workspace/db");
    closeDb();
    rmSync(dir, { recursive: true, force: true });
  });

  test("refuses a request without a token", async () => {
    const response = await app.request(attachmentUrl({}));

    expect(response.status).toBe(401);
  });

  test("serves the stored bytes with an immutable cache and the sniffed type", async () => {
    const response = await app.request(attachmentUrl({}), { headers });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toContain("immutable");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    await expect(response.arrayBuffer()).resolves.toStrictEqual(
      PNG_BYTES.buffer
    );
  });

  test("answers HEAD with the length and no body", async () => {
    const response = await app.request(attachmentUrl({}), {
      method: "HEAD",
      headers,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe(
      String(PNG_BYTES.byteLength)
    );
    await expect(response.arrayBuffer()).resolves.toHaveProperty(
      "byteLength",
      0
    );
  });

  test("reports an unknown digest as not found", async () => {
    const response = await app.request(
      attachmentUrl({ sha256: "a".repeat(64) }),
      { headers }
    );

    expect(response.status).toBe(404);
  });

  test("refuses an address that is not a digest, before it reaches the filesystem", async () => {
    const escaped = await app.request(attachmentUrl({ sha256: "../escape" }), {
      headers,
    });
    const notASession = await app.request(attachmentUrl({ owner: "bot:b1" }), {
      headers,
    });

    expect(escaped.status).toBe(400);
    expect(notASession.status).toBe(400);
  });
});
