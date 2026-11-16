import type {
  AgentSteeringStep,
  AgentUserTurn,
  EnqueueInboxInput,
  InboxItem,
  DeliverAt,
} from "@workspace/agent-client";
import { describe, expect, test } from "vitest";

import { AgentInbox } from "../../src/inbox/agent-inbox.js";
import type { AgentStore } from "../../src/storage/index.js";

const userTurn = (id: string, text: string): AgentUserTurn => ({
  id,
  type: "user",
  createdAt: 1,
  status: "done",
  content: [
    {
      id: `${id}-step`,
      type: "user",
      createdAt: 1,
      status: "done",
      content: [{ type: "text", text, createdAt: 1 }],
    },
  ],
});

const inboxInput = (
  dedupeKey: string,
  deliverAt: DeliverAt,
  text: string
): EnqueueInboxInput => ({
  sessionId: "session-1",
  kind: "user-message",
  dedupeKey,
  deliverAt,
  content: userTurn(`turn-${dedupeKey}`, text),
  payload: { model: { providerId: "test-provider", modelId: "test-model" } },
});

/**
 * Inbox 的内存替身。
 *
 * 它实现的是 store 的契约：幂等入队、按 seq 排序、原子领取。`AgentInbox`
 * 本身只表达这些动作，所以测试断言的是动作的结果，不是 SQL。
 */
class FakeStore {
  messages: InboxItem[] = [];
  #nextSeq = 0;
  #nextId = 0;

  insertInboxMessage(input: EnqueueInboxInput): Promise<InboxItem> {
    const existing = this.messages.find(
      (message) =>
        message.sessionId === input.sessionId &&
        message.dedupeKey === input.dedupeKey
    );
    if (existing) {
      return Promise.resolve(existing);
    }

    const message: InboxItem = {
      seq: this.#nextSeq,
      id: `inbox-${this.#nextId}`,
      sessionId: input.sessionId,
      kind: input.kind,
      dedupeKey: input.dedupeKey,
      deliverAt: input.deliverAt,
      content: input.content,
      payload: input.payload,
      createdAt: 1,
    };

    this.#nextSeq += 1;
    this.#nextId += 1;
    this.messages.push(message);
    return Promise.resolve(message);
  }

  listInboxMessages(
    sessionId: string,
    options?: { deliverAt?: DeliverAt }
  ): Promise<InboxItem[]> {
    return Promise.resolve(
      this.messages
        .filter(
          (message) =>
            message.sessionId === sessionId &&
            (options?.deliverAt === undefined ||
              message.deliverAt === options.deliverAt)
        )
        .toSorted((left, right) => left.seq - right.seq)
    );
  }

  deleteInboxMessages(
    sessionId: string,
    ids?: readonly string[]
  ): Promise<number> {
    const before = this.messages.length;
    this.messages = this.messages.filter(
      (message) =>
        !(
          message.sessionId === sessionId &&
          (ids === undefined || ids.includes(message.id))
        )
    );
    return Promise.resolve(before - this.messages.length);
  }

  applySteeringSteps({
    sessionId,
    turnId: _turnId,
    streamId: _streamId,
    messageIds,
  }: {
    sessionId: string;
    turnId: string;
    streamId: string;
    messageIds: string[];
  }): Promise<AgentSteeringStep[]> {
    const claimed = this.messages.filter(
      (message) =>
        message.sessionId === sessionId && messageIds.includes(message.id)
    );
    const claimedIds = new Set(claimed.map((message) => message.id));
    this.messages = this.messages.filter(
      (message) => !claimedIds.has(message.id)
    );

    return Promise.resolve(
      claimed
        .toSorted((left, right) => left.seq - right.seq)
        .map((message) => ({
          id: message.id,
          type: "steering" as const,
          createdAt: message.createdAt,
          completedAt: message.createdAt,
          status: "done" as const,
          content: message.content.content.flatMap((step) => step.content),
        }))
    );
  }
}

const inboxOf = (store: FakeStore): AgentInbox =>
  new AgentInbox(store as unknown as AgentStore);

describe(AgentInbox, () => {
  test("lists pending messages in FIFO order", async () => {
    const store = new FakeStore();
    const inbox = inboxOf(store);

    await inbox.enqueue(inboxInput("request-1", "run-boundary", "first"));
    await inbox.enqueue(inboxInput("request-2", "run-boundary", "second"));

    await expect(inbox.list("session-1")).resolves.toMatchObject([
      { dedupeKey: "request-1", deliverAt: "run-boundary" },
      { dedupeKey: "request-2", deliverAt: "run-boundary" },
    ]);
  });

  test("returns the existing message when the same request is enqueued twice", async () => {
    const store = new FakeStore();
    const inbox = inboxOf(store);

    const first = await inbox.enqueue(
      inboxInput("request-1", "run-boundary", "once")
    );
    const second = await inbox.enqueue(
      inboxInput("request-1", "step-boundary", "changed")
    );

    expect(second.id).toBe(first.id);
    expect(second.deliverAt).toBe("run-boundary");
    await expect(inbox.list("session-1")).resolves.toHaveLength(1);
  });

  test("lists only step-boundary items for steering", async () => {
    const store = new FakeStore();
    const inbox = inboxOf(store);

    await inbox.enqueue(inboxInput("request-1", "step-boundary", "steer"));
    await inbox.enqueue(inboxInput("request-2", "run-boundary", "queue"));

    await expect(inbox.listSteering("session-1")).resolves.toMatchObject([
      { dedupeKey: "request-1", deliverAt: "step-boundary" },
    ]);
  });

  test("cancels one message and clears the rest", async () => {
    const store = new FakeStore();
    const inbox = inboxOf(store);

    const first = await inbox.enqueue(
      inboxInput("request-1", "run-boundary", "first")
    );
    await inbox.enqueue(inboxInput("request-2", "run-boundary", "second"));

    await expect(inbox.cancel("session-1", first.id)).resolves.toBe(1);
    await expect(inbox.list("session-1")).resolves.toHaveLength(1);
    await expect(inbox.clear("session-1")).resolves.toBe(1);
    await expect(inbox.list("session-1")).resolves.toStrictEqual([]);
  });

  test("applies steering once and removes the claimed messages", async () => {
    const store = new FakeStore();
    const inbox = inboxOf(store);

    const first = await inbox.enqueue(
      inboxInput("request-1", "step-boundary", "one")
    );
    const second = await inbox.enqueue(
      inboxInput("request-2", "step-boundary", "two")
    );

    const steps = await inbox.applySteeringSteps({
      sessionId: "session-1",
      turnId: "turn-1",
      streamId: "stream-1",
      messageIds: [second.id, first.id],
    });

    expect(steps.map((step) => step.id)).toStrictEqual([first.id, second.id]);
    expect(steps.map((step) => step.content)).toMatchObject([
      [{ type: "text", text: "one" }],
      [{ type: "text", text: "two" }],
    ]);
    await expect(inbox.list("session-1")).resolves.toStrictEqual([]);

    await expect(
      inbox.applySteeringSteps({
        sessionId: "session-1",
        turnId: "turn-1",
        streamId: "stream-1",
        messageIds: [first.id],
      })
    ).resolves.toStrictEqual([]);
  });
});
