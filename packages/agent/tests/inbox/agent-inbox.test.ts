import type {
  AgentSteeringStep,
  AgentUserTurn,
  EnqueueInboxInput,
  InboxMessage,
  InboxPlacement,
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
  requestId: string,
  placement: InboxPlacement,
  text: string
): EnqueueInboxInput => ({
  sessionId: "session-1",
  requestId,
  placement,
  content: userTurn(`turn-${requestId}`, text),
  payload: { model: "test-model" },
});

/**
 * Inbox 的内存替身。
 *
 * 它实现的是 store 的契约：幂等入队、按 seq 排序、原子领取。`AgentInbox`
 * 本身只表达这些动作，所以测试断言的是动作的结果，不是 SQL。
 */
class FakeStore {
  messages: InboxMessage[] = [];
  #nextSeq = 0;
  #nextId = 0;

  insertInboxMessage(input: EnqueueInboxInput): Promise<InboxMessage> {
    const existing = this.messages.find(
      (message) =>
        message.sessionId === input.sessionId &&
        message.requestId === input.requestId
    );
    if (existing) {
      return Promise.resolve(existing);
    }

    const message: InboxMessage = {
      seq: this.#nextSeq,
      id: `inbox-${this.#nextId}`,
      sessionId: input.sessionId,
      requestId: input.requestId,
      placement: input.placement,
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
    options?: { placement?: InboxPlacement }
  ): Promise<InboxMessage[]> {
    return Promise.resolve(
      this.messages
        .filter(
          (message) =>
            message.sessionId === sessionId &&
            (options?.placement === undefined ||
              message.placement === options.placement)
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

  promoteStaleInboxMessages(sessionId: string): Promise<number> {
    let promoted = 0;
    this.messages = this.messages.map((message) => {
      if (
        message.sessionId === sessionId &&
        message.placement === "next-step"
      ) {
        promoted += 1;
        return { ...message, placement: "next-turn" };
      }
      return message;
    });
    return Promise.resolve(promoted);
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

    await inbox.enqueue(inboxInput("request-1", "next-turn", "first"));
    await inbox.enqueue(inboxInput("request-2", "next-turn", "second"));

    await expect(inbox.list("session-1")).resolves.toMatchObject([
      { requestId: "request-1", placement: "next-turn" },
      { requestId: "request-2", placement: "next-turn" },
    ]);
  });

  test("returns the existing message when the same request is enqueued twice", async () => {
    const store = new FakeStore();
    const inbox = inboxOf(store);

    const first = await inbox.enqueue(
      inboxInput("request-1", "next-turn", "once")
    );
    const second = await inbox.enqueue(
      inboxInput("request-1", "next-step", "changed")
    );

    expect(second.id).toBe(first.id);
    expect(second.placement).toBe("next-turn");
    await expect(inbox.list("session-1")).resolves.toHaveLength(1);
  });

  test("lists only next-step messages for steering", async () => {
    const store = new FakeStore();
    const inbox = inboxOf(store);

    await inbox.enqueue(inboxInput("request-1", "next-step", "steer"));
    await inbox.enqueue(inboxInput("request-2", "next-turn", "queue"));

    await expect(inbox.listSteering("session-1")).resolves.toMatchObject([
      { requestId: "request-1", placement: "next-step" },
    ]);
  });

  test("cancels one message and clears the rest", async () => {
    const store = new FakeStore();
    const inbox = inboxOf(store);

    const first = await inbox.enqueue(
      inboxInput("request-1", "next-turn", "first")
    );
    await inbox.enqueue(inboxInput("request-2", "next-turn", "second"));

    await expect(inbox.cancel("session-1", first.id)).resolves.toBe(1);
    await expect(inbox.list("session-1")).resolves.toHaveLength(1);
    await expect(inbox.clear("session-1")).resolves.toBe(1);
    await expect(inbox.list("session-1")).resolves.toStrictEqual([]);
  });

  test("promotes leftover next-step messages to next-turn", async () => {
    const store = new FakeStore();
    const inbox = inboxOf(store);

    await inbox.enqueue(inboxInput("request-1", "next-step", "steer"));
    await inbox.enqueue(inboxInput("request-2", "next-turn", "queue"));

    await expect(inbox.promoteStale("session-1")).resolves.toBe(1);
    await expect(inbox.list("session-1")).resolves.toMatchObject([
      { requestId: "request-1", placement: "next-turn" },
      { requestId: "request-2", placement: "next-turn" },
    ]);
  });

  test("applies steering once and removes the claimed messages", async () => {
    const store = new FakeStore();
    const inbox = inboxOf(store);

    const first = await inbox.enqueue(
      inboxInput("request-1", "next-step", "one")
    );
    const second = await inbox.enqueue(
      inboxInput("request-2", "next-step", "two")
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
