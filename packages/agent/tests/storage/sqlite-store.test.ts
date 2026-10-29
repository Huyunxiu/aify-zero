import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { beforeAll, describe, expect, test } from "vitest";

import type { AgentStore } from "../../src/storage/index.js";
import { assistantStep, assistantTurn } from "../compaction/fixtures.js";

// `@workspace/db` 在导入时就按 `DATABASE_URL` 建连接，所以选库必须发生在它
// 被加载之前；这里先设环境变量，再在 `beforeAll` 里动态导入。
const dir = mkdtempSync(path.join(tmpdir(), "aify-store-"));
process.env.DATABASE_URL = `file:${path.join(dir, "test.db")}`;
process.env.AIFY_MIGRATIONS_DIR = path.resolve(
  import.meta.dirname,
  "../../../db/src/migrations"
);

let store: AgentStore;

describe("SQLiteStore#updateTurn", () => {
  beforeAll(async () => {
    const { migrateDb } = await import("@workspace/db");
    await migrateDb();

    const { SQLiteStore } = await import("../../src/storage/sqlite-store.js");
    store = new SQLiteStore();
  });

  test("writes only the steps named by stepIds", async () => {
    const first = assistantStep("step-1", { text: "first" });
    const second = assistantStep("step-2", { text: "second" });
    const turn = assistantTurn("turn-1", [first, second]);

    await store.saveSession({
      id: "session-1",
      title: "",
      metadata: {},
      projectId: null,
    });
    await store.saveTurn({
      id: "turn-1",
      sessionId: "session-1",
      type: "assistant",
      metadata: {},
      content: turn,
      createdAt: new Date(1),
    });

    // 只改内存里的第二条，也只回写第二条。
    second.content = [
      { type: "text", text: "changed", state: "done", createdAt: 1 },
    ];
    const updated = await store.updateTurn("turn-1", turn, {
      stepIds: new Set(["step-2"]),
    });

    expect(updated).toBe(1);

    await store.setActiveHead("session-1", "turn-1");
    const [record] = await store.getBranchTurns("session-1");
    const steps = record?.content.content ?? [];
    const texts = steps.map((step) => {
      const [part] = step.content;
      return part?.type === "text" ? part.text : undefined;
    });

    expect(texts).toStrictEqual(["first", "changed"]);
  });

  test("returns 0 when the turn row does not exist", async () => {
    const turn = assistantTurn("missing", [assistantStep("step-9")]);

    await expect(store.updateTurn("missing", turn)).resolves.toBe(0);
  });
});
