import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, test } from "vitest";

// 数据层在 import 时就连库，所以先指到临时文件，再动态引入。
const directory = await mkdtemp(path.join(tmpdir(), "aify-mcp-credential-"));
process.env.DATABASE_URL = `file:${path.join(directory, "test.db")}`;

const { closeDb, migrateDb } = await import("@workspace/db");
const { SqliteMcpCredentialStore } = await import("../src/mcp/credentials");

// 表结构只有迁移一个来源；手写 DDL 会和 schema 各写一遍，schema 加列时这里
// 仍然通过，测的就不是真正的表。
await migrateDb();

describe(SqliteMcpCredentialStore, () => {
  afterAll(async () => {
    closeDb();
    await rm(directory, { recursive: true, force: true });
  });

  test("increments the generation on every write", async () => {
    const store = new SqliteMcpCredentialStore();

    const first = await store.write("generation", "tokens", { value: "a" });
    const second = await store.write("generation", "tokens", { value: "b" });

    expect([first.generation, second.generation]).toStrictEqual([0, 1]);
    await expect(store.read("generation", "tokens")).resolves.toStrictEqual({
      value: { value: "b" },
      generation: 1,
    });
  });

  test("keeps a token that a late delete tries to remove with an old generation", async () => {
    const store = new SqliteMcpCredentialStore();

    const first = await store.write("stale", "tokens", { value: "old" });
    const second = await store.write("stale", "tokens", { value: "new" });

    await expect(
      store.delete("stale", "tokens", first.generation)
    ).resolves.toBeFalsy();
    const kept = await store.read("stale", "tokens");
    expect(kept?.value).toStrictEqual({ value: "new" });

    await expect(
      store.delete("stale", "tokens", second.generation)
    ).resolves.toBeTruthy();
    await expect(store.read("stale", "tokens")).resolves.toBeUndefined();
  });

  test("deletes every kind for one server, and only that server", async () => {
    const store = new SqliteMcpCredentialStore();

    await store.write("cleared", "tokens", { value: 1 });
    await store.write("cleared", "client", { client_id: "id" });
    await store.write("kept", "tokens", { value: 2 });

    await store.deleteAll("cleared");

    await expect(store.read("cleared", "tokens")).resolves.toBeUndefined();
    await expect(store.read("cleared", "client")).resolves.toBeUndefined();
    await expect(store.read("kept", "tokens")).resolves.toBeDefined();
  });
});
