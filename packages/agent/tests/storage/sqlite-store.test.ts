import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { EnqueueInboxInput } from "@workspace/agent-client";
import { beforeAll, describe, expect, test } from "vitest";

import { InboxMessageNotFoundError } from "../../src/inbox/errors.js";
import type { AgentStore, TurnWrite } from "../../src/storage/index.js";
import {
  assistantStep,
  assistantTurn,
  userTurn,
} from "../compaction/fixtures.js";

// `@workspace/db` 在导入时就按 `DATABASE_URL` 建连接，所以选库必须发生在它
// 被加载之前；这里先设环境变量，再在 `beforeAll` 里动态导入。
const dir = mkdtempSync(path.join(tmpdir(), "aify-store-"));
process.env.DATABASE_URL = `file:${path.join(dir, "test.db")}`;
process.env.AIFY_MIGRATIONS_DIR = path.resolve(
  import.meta.dirname,
  "../../../db/src/migrations"
);

let store: AgentStore;

describe("SQLiteStore", () => {
  beforeAll(async () => {
    const { migrateDb } = await import("@workspace/db");
    await migrateDb();

    const { SQLiteStore } = await import("../../src/storage/sqlite-store.js");
    store = new SQLiteStore();
  });

  describe("updateTurn", () => {
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
      await store.saveTurn(
        {
          id: "turn-1",
          sessionId: "session-1",
          type: "assistant",
          metadata: {},
          content: turn,
          createdAt: new Date(1),
        },
        { head: true }
      );

      // 只改内存里的第二条，也只回写第二条。
      second.content = [
        { type: "text", text: "changed", state: "done", createdAt: 1 },
      ];
      const updated = await store.updateTurn("turn-1", turn, {
        stepIds: new Set(["step-2"]),
      });

      expect(updated).toBe(1);

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

  describe("inbox", () => {
    const sessionId = "session-inbox";

    const inboxInput = (
      requestId: string,
      text: string
    ): EnqueueInboxInput => ({
      sessionId,
      requestId,
      placement: "next-turn",
      content: userTurn(`turn-${requestId}`, text),
      payload: { model: "test-model" },
    });

    test("入队按 (sessionId, requestId) 幂等", async () => {
      const input = inboxInput("req-1", "hello");
      const first = await store.insertInboxMessage(input);
      const second = await store.insertInboxMessage(input);

      expect(second.id).toBe(first.id);

      const listed = await store.listInboxMessages(sessionId);
      expect(listed.map((message) => message.id)).toStrictEqual([first.id]);
    });

    test("按 id 删除，空集合不删；省略 ids 时清空", async () => {
      await store.deleteInboxMessages(sessionId);
      const kept = await store.insertInboxMessage(inboxInput("req-2", "keep"));
      const removed = await store.insertInboxMessage(
        inboxInput("req-3", "drop")
      );

      await expect(store.deleteInboxMessages(sessionId, [])).resolves.toBe(0);
      await expect(
        store.deleteInboxMessages(sessionId, [removed.id])
      ).resolves.toBe(1);
      const remaining = await store.listInboxMessages(sessionId);
      expect(remaining.map((message) => message.id)).toStrictEqual([kept.id]);

      await expect(store.deleteInboxMessages(sessionId)).resolves.toBe(1);
      await expect(store.listInboxMessages(sessionId)).resolves.toHaveLength(0);
    });

    test("saveTurn 带 inboxId 时认领消息；重复领取抛错", async () => {
      const message = await store.insertInboxMessage(
        inboxInput("req-4", "claim me")
      );
      const turn: TurnWrite = {
        id: "turn-claim",
        sessionId,
        type: "user",
        metadata: {},
        content: userTurn("turn-claim", "claim me"),
        createdAt: new Date(1),
      };

      await expect(store.saveTurn(turn, { inboxId: message.id })).resolves.toBe(
        1
      );
      await expect(store.listInboxMessages(sessionId)).resolves.toHaveLength(0);

      await expect(
        store.saveTurn(turn, { inboxId: message.id })
      ).rejects.toBeInstanceOf(InboxMessageNotFoundError);
    });
  });
});
