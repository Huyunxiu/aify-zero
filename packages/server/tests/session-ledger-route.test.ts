/**
 * The session ledger route: the real app, the real database, and the real files.
 *
 * The reader and the projection have their own cases in `packages/agent/tests`. This proves
 * the one seam those cannot reach: the route answers from the file on disk, honors `from`
 * and `limit`, and refuses a session that was deleted.
 *
 * `@workspace/db` opens its connection from `DATABASE_URL` at import, so select the database
 * before the import. The ledger lives under the home directory, so that moves too.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { beforeAll, describe, expect, test } from "vitest";

import type { AppRouterClient } from "../src/routers/index";
import type { SQLiteStore } from "../src/storage/sqlite-store";

const dir = mkdtempSync(path.join(tmpdir(), "aify-session-ledger-"));
process.env.DATABASE_URL = `file:${path.join(dir, "test.db")}`;
process.env.HOME = dir;

const API_TOKEN = "test-api-token";

let client: AppRouterClient;
let store: SQLiteStore;

/** The ledger file the route must read, at the path the app derives from `HOME`. */
function ledgerOf(sessionId: string): string {
  return path.join(dir, ".aify-zero", "sessions", sessionId, "ledger.jsonl");
}

/**
 * Three records, written by hand.
 *
 * Hand-written on purpose: a case that used the recorder would pass even if the format and
 * the reader had drifted together.
 */
const RECORDS = [
  {
    line: 1,
    v: 1,
    at: 1000,
    epoch: "e1",
    type: "note.process",
    pid: 413,
    appVersion: "0.4.1",
  },
  {
    line: 2,
    v: 1,
    at: 1001,
    epoch: "e1",
    type: "stream.run.start",
    streamId: "k1",
  },
  {
    line: 3,
    v: 1,
    at: 1002,
    epoch: "e1",
    type: "stream.run.end",
    streamId: "k1",
  },
];

function writeLedger(sessionId: string): void {
  const file = ledgerOf(sessionId);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(
    file,
    `${RECORDS.map((row) => JSON.stringify(row)).join("\n")}\n`
  );
}

describe("the ledger route", () => {
  beforeAll(async () => {
    const { migrateDb } = await import("@workspace/db");
    await migrateDb();

    const { createApp } = await import("../src/app");
    const app = createApp({ apiToken: () => API_TOKEN });

    const storeModule = await import("../src/storage/sqlite-store");
    store = new storeModule.SQLiteStore();

    client = createORPCClient(
      new RPCLink({
        url: "http://aify.test/api/rpc",
        headers: { authorization: `Bearer ${API_TOKEN}` },
        fetch: async (request) => await app.request(request),
      })
    );
  });

  test("answers from the file, in the order the file holds", async () => {
    await store.saveSession({ id: "s1", title: "Ledger", metadata: {} });
    writeLedger("s1");

    const read = await client.session.streamSessionLedger({ sessionId: "s1" });

    expect(read.records.map((record) => record.type)).toStrictEqual([
      "note.process",
      "stream.run.start",
      "stream.run.end",
    ]);
    expect(read.records.map((record) => record.line)).toStrictEqual([1, 2, 3]);
    expect(read.next).toBeNull();
  });

  test("honors a page and names the next line", async () => {
    const read = await client.session.streamSessionLedger({
      sessionId: "s1",
      from: 2,
      limit: 1,
    });

    expect(read.records.map((record) => record.line)).toStrictEqual([2]);
    expect(read.next).toBe(3);
  });

  test("refuses a session that was deleted", async () => {
    await store.saveSession({ id: "s2", title: "Gone", metadata: {} });
    writeLedger("s2");
    await client.session.deleteSession({ sessionId: "s2" });

    await expect(
      client.session.streamSessionLedger({ sessionId: "s2" })
    ).rejects.toThrow(/not found/u);
  });

  test("answers a session with no ledger with nothing", async () => {
    await store.saveSession({ id: "s3", title: "Empty", metadata: {} });

    const read = await client.session.streamSessionLedger({ sessionId: "s3" });

    expect(read.records).toStrictEqual([]);
    expect(read.tailTruncated).toBeFalsy();
  });
});
