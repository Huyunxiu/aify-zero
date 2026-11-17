import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { EnqueueInboxInput } from "@workspace/agent-client";
import { InboxItemNotFoundError } from "@workspace/agent/store";
import type { AgentStore, TurnWrite } from "@workspace/agent/store";
import { beforeAll, describe, expect, test } from "vitest";

import {
  assistantStep,
  assistantTurn,
  userTurn,
} from "../helpers/compaction-fixtures.js";

// `@workspace/db` 在导入时就按 `DATABASE_URL` 建连接，所以选库必须发生在它
// 被加载之前；这里先设环境变量，再在 `beforeAll` 里动态导入。
const dir = mkdtempSync(path.join(tmpdir(), "aify-store-"));
process.env.DATABASE_URL = `file:${path.join(dir, "test.db")}`;

let store: AgentStore;

/** 一条由收件箱行写成的 user turn；`owner` 必须和领取的会话一致。 */
const claimedTurn = (id: string, text: string, owner: string): TurnWrite => ({
  id,
  sessionId: owner,
  type: "user",
  metadata: {},
  content: userTurn(id, text),
  createdAt: new Date(1),
});

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
      const updated = await store.updateTurn("session-1", "turn-1", turn, {
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

      await expect(
        store.updateTurn("session-1", "missing", turn)
      ).resolves.toBe(0);
    });

    test("fork copies share business ids but not rows", async () => {
      const sourceId = "session-source";
      const forkId = "session-fork";
      const turnId = "turn-shared";

      await store.saveSession({
        id: sourceId,
        title: "",
        metadata: {},
        projectId: null,
        activeHeadId: turnId,
      });
      await store.saveSession({
        id: forkId,
        title: "",
        metadata: {},
        projectId: null,
        activeHeadId: turnId,
      });

      const sourceTurn = assistantTurn(turnId, [
        assistantStep("step-shared", { text: "source" }),
      ]);
      await store.saveTurn(
        {
          id: turnId,
          sessionId: sourceId,
          type: "assistant",
          metadata: {},
          content: sourceTurn,
          createdAt: new Date(1),
        },
        { head: false }
      );

      // fork 复制同一组业务 id，只换会话。
      const forkTurn = assistantTurn(turnId, [
        assistantStep("step-shared", { text: "source" }),
      ]);
      await store.saveTurns([
        {
          id: turnId,
          sessionId: forkId,
          type: "assistant",
          metadata: {},
          content: forkTurn,
          createdAt: new Date(1),
        },
      ]);

      // 只改 fork；源会话不能跟着变。
      forkTurn.content[0]!.content = [
        { type: "text", text: "fork only", state: "done", createdAt: 1 },
      ];
      await store.updateTurn(forkId, turnId, forkTurn, {
        stepIds: new Set(["step-shared"]),
      });

      const [sourceRecord] = await store.getBranchTurns(sourceId);
      const sourcePart = sourceRecord?.content.content[0]?.content[0];
      expect(sourcePart?.type === "text" ? sourcePart.text : undefined).toBe(
        "source"
      );

      // 两行都在，但物理主键不同。
      const { db, turn_table } = await import("@workspace/db");
      const rows = await db
        .select({
          rowId: turn_table.rowId,
          turnId: turn_table.turnId,
          sessionId: turn_table.sessionId,
        })
        .from(turn_table);
      const copies = rows.filter((row) => row.turnId === turnId);
      expect(copies).toHaveLength(2);
      expect(new Set(copies.map((row) => row.rowId)).size).toBe(2);
      expect(new Set(copies.map((row) => row.sessionId))).toStrictEqual(
        new Set([sourceId, forkId])
      );
    });
  });

  describe("inbox", () => {
    const sessionId = "session-inbox";

    const inboxInput = (
      dedupeKey: string,
      text: string
    ): EnqueueInboxInput => ({
      sessionId,
      kind: "user-message",
      dedupeKey,
      deliverAt: "run-boundary",
      content: userTurn(`turn-${dedupeKey}`, text),
      payload: {
        model: { providerId: "test-provider", modelId: "test-model" },
      },
    });

    test("入队按 (sessionId, dedupeKey) 幂等", async () => {
      const input = inboxInput("req-1", "hello");
      const first = await store.insertInboxItem(input);
      const second = await store.insertInboxItem(input);

      expect(second.id).toBe(first.id);

      const listed = await store.listInboxItems(sessionId);
      expect(listed.map((message) => message.id)).toStrictEqual([first.id]);
    });

    test("按 id 删除，空集合不删；省略 ids 时清空", async () => {
      await store.deleteInboxItems(sessionId);
      const kept = await store.insertInboxItem(inboxInput("req-2", "keep"));
      const removed = await store.insertInboxItem(inboxInput("req-3", "drop"));

      await expect(store.deleteInboxItems(sessionId, [])).resolves.toBe(0);
      await expect(
        store.deleteInboxItems(sessionId, [removed.id])
      ).resolves.toBe(1);
      const remaining = await store.listInboxItems(sessionId);
      expect(remaining.map((message) => message.id)).toStrictEqual([kept.id]);

      await expect(store.deleteInboxItems(sessionId)).resolves.toBe(1);
      await expect(store.listInboxItems(sessionId)).resolves.toHaveLength(0);
    });

    test("saveClaimedTurns 认领整批并串起父链；重复领取抛错", async () => {
      await store.saveSession({
        id: sessionId,
        title: "",
        metadata: {},
        projectId: null,
      });
      const first = await store.insertInboxItem(inboxInput("req-4", "first"));
      const second = await store.insertInboxItem(inboxInput("req-5", "second"));

      const written = await store.saveClaimedTurns({
        sessionId,
        claims: [
          {
            inboxId: first.id,
            turn: claimedTurn("turn-claim-1", "first", sessionId),
          },
          {
            inboxId: second.id,
            turn: claimedTurn("turn-claim-2", "second", sessionId),
          },
        ],
        head: true,
      });

      expect(written).toStrictEqual(["turn-claim-1", "turn-claim-2"]);
      await expect(store.listInboxItems(sessionId)).resolves.toHaveLength(0);

      const branch = await store.getBranchTurns(sessionId);
      expect(branch.map((turn) => turn.id)).toStrictEqual([
        "turn-claim-1",
        "turn-claim-2",
      ]);
      expect(branch[1]?.parentId).toBe("turn-claim-1");

      await expect(
        store.saveClaimedTurns({
          sessionId,
          claims: [
            {
              inboxId: first.id,
              turn: claimedTurn("turn-claim-3", "again", sessionId),
            },
          ],
        })
      ).rejects.toBeInstanceOf(InboxItemNotFoundError);
    });

    test("saveClaimedTurns 只写还存在的行，父链从剩下的重算", async () => {
      const owner = "session-inbox-partial";
      await store.saveSession({
        id: owner,
        title: "",
        metadata: {},
        projectId: null,
      });
      const inbox = (key: string, text: string): EnqueueInboxInput => ({
        ...inboxInput(key, text),
        sessionId: owner,
      });

      const first = await store.insertInboxItem(inbox("req-6", "first"));
      const second = await store.insertInboxItem(inbox("req-7", "second"));
      const third = await store.insertInboxItem(inbox("req-8", "third"));

      await store.deleteInboxItems(owner, [second.id]);

      const written = await store.saveClaimedTurns({
        sessionId: owner,
        claims: [
          {
            inboxId: first.id,
            turn: claimedTurn("turn-part-1", "first", owner),
          },
          {
            inboxId: second.id,
            turn: claimedTurn("turn-part-2", "second", owner),
          },
          {
            inboxId: third.id,
            turn: claimedTurn("turn-part-3", "third", owner),
          },
        ],
        head: true,
      });

      expect(written).toStrictEqual(["turn-part-1", "turn-part-3"]);

      const branch = await store.getBranchTurns(owner);
      expect(branch.map((turn) => turn.id)).toStrictEqual([
        "turn-part-1",
        "turn-part-3",
      ]);
      expect(branch[1]?.parentId).toBe("turn-part-1");
    });
  });

  describe("并发写", () => {
    test("事务打开时到达的写排队等待，而不是 SQLITE_BUSY", async () => {
      const { db, session_table } = await import("@workspace/db");
      const { eq } = await import("drizzle-orm");

      await store.saveSession({
        id: "session-busy",
        title: "",
        metadata: {},
        projectId: null,
      });

      const opened = deferred();
      const finish = deferred();

      // 用 drizzle 开一个事务：libsql 会为之后到达的查询另开一条连接，没有
      // 排队时它立刻以 SQLITE_BUSY 失败。
      const transaction = db.transaction(async (tx) => {
        await tx
          .update(session_table)
          .set({ status: "running" })
          .where(eq(session_table.id, "session-busy"));
        opened.resolve();
        await finish.promise;
      });

      await opened.promise;

      const write = store.setActiveStream("session-busy", "stream-1").then(
        (rowsAffected) => ({ ok: true as const, rowsAffected }),
        (error: unknown) => ({ ok: false as const, error })
      );

      finish.resolve();
      await transaction;

      await expect(write).resolves.toStrictEqual({ ok: true, rowsAffected: 1 });
    });
  });
});

/** 手动可控的 promise，用来把事务卡在中间。 */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, resolve: release };
}
