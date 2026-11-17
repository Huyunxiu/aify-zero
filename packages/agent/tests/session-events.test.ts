import type {
  AgentStreamEvent,
  AgentUserTurn,
  SessionStreamEvent,
} from "@workspace/agent-client";
import { describe, expect, test } from "vitest";

import { SessionEventRegistry } from "../src/session-events";

const turnStart = (turnId: string): AgentStreamEvent<never> =>
  ({
    createdAt: 1,
    turnId,
    turnType: "assistant",
    type: "turn.start",
  }) as AgentStreamEvent<never>;

const textStart = (turnId: string, partId: string): AgentStreamEvent<never> =>
  ({
    createdAt: 1,
    id: partId,
    stepId: `${turnId}-step`,
    turnId,
    type: "text.start",
  }) as AgentStreamEvent<never>;

/** 从一条不关闭的流上读 n 条事件。 */
const readEvents = async (
  stream: ReadableStream<SessionStreamEvent<never>>,
  count: number
): Promise<SessionStreamEvent<never>[]> => {
  const reader = stream.getReader();
  const events: SessionStreamEvent<never>[] = [];
  // 读满就放掉读取器，剩下的没人关心。
  for (let index = 0; index < count; index += 1) {
    const { value } = await reader.read();
    events.push(value!);
  }
  await reader.cancel();

  return events;
};

describe(SessionEventRegistry, () => {
  test("reads a run and the next one on the same connection", async () => {
    const events = new SessionEventRegistry<never>();
    const stream = events.subscribe("session-1");

    events.startRun("session-1", "run-1");
    events.publish("session-1", "run-1", turnStart("turn-1"));
    events.endRun("session-1", "run-1");
    events.startRun("session-1", "run-2");

    const received = await readEvents(stream, 5);

    expect(received.map((event) => event.type)).toStrictEqual([
      "ready",
      "run.start",
      "run.event",
      "run.end",
      "run.start",
    ]);
    expect(received[4]).toMatchObject({ streamId: "run-2" });
  });

  test("a late reader gets the live run from its start", async () => {
    const events = new SessionEventRegistry<never>();

    events.startRun("session-1", "run-1", { turnId: "turn-1" });
    events.publish("session-1", "run-1", turnStart("turn-1"));
    events.publish("session-1", "run-1", textStart("turn-1", "part-1"));

    const stream = events.subscribe("session-1");
    const received = await readEvents(stream, 4);

    // `ready` 报的是重放的下界：之后每条事件的序号都比它大。
    expect(received[0]).toMatchObject({ seq: 0 });
    expect(received[1]).toStrictEqual({
      seq: 1,
      streamId: "run-1",
      turnId: "turn-1",
      type: "run.start",
    });
    // 重放的是 buffered 事件的原始序号，读者可以从这里往后接着读。
    expect(received.slice(2)).toStrictEqual([
      {
        event: expect.objectContaining({ type: "turn.start" }),
        seq: 2,
        streamId: "run-1",
        type: "run.event",
      },
      {
        event: expect.objectContaining({ type: "text.start" }),
        seq: 3,
        streamId: "run-1",
        type: "run.event",
      },
    ]);
  });

  test("a turn the reader never sent arrives with the run", async () => {
    const events = new SessionEventRegistry<never>();

    // 运行器自己发起的回合（例如后台任务的完成通知）：读者手里没有它，也不
    // 可能来得及在收件箱里看见它，所以内容必须随 `run.start` 一起过去。
    const turn = {
      id: "turn-notice",
      type: "user",
      createdAt: 1,
      status: "done",
      content: [
        {
          id: "step-notice",
          type: "user",
          createdAt: 1,
          status: "done",
          source: "job-notice",
          content: [{ type: "text", text: "job finished", createdAt: 1 }],
        },
      ],
    } as unknown as AgentUserTurn;

    events.startRun("session-1", "run-1", { turnId: turn.id, turn });

    const received = await readEvents(events.subscribe("session-1"), 2);

    expect(received[1]).toStrictEqual({
      seq: 1,
      streamId: "run-1",
      turnId: "turn-notice",
      turn,
      type: "run.start",
    });
  });

  test("does not replay a run that already finished", async () => {
    const events = new SessionEventRegistry<never>();

    events.startRun("session-1", "run-1");
    events.endRun("session-1", "run-1", "model exploded");

    const stream = events.subscribe("session-1");
    // 只有握手：跑完的运行已经在会话记录里了。
    const received = await readEvents(stream, 1);

    expect(received).toHaveLength(1);
    expect(received[0]?.type).toBe("ready");
  });

  test("continues after the reader's cursor", async () => {
    const events = new SessionEventRegistry<never>();

    events.startRun("session-1", "run-1");
    events.publish("session-1", "run-1", turnStart("turn-1"));
    events.publish("session-1", "run-1", textStart("turn-1", "part-1"));

    const head = await readEvents(events.subscribe("session-1"), 1);
    const epoch = head[0]?.type === "ready" ? head[0].epoch : "";

    // 读到第二条（`seq` 2）之后重连：从第三条接着发。
    const received = await readEvents(
      events.subscribe("session-1", { epoch, seq: 2 }),
      3
    );

    expect(received.map((event) => event.type)).toStrictEqual([
      "ready",
      "run.start",
      "run.event",
    ]);
    expect(received[0]).toMatchObject({ seq: 2 });
    expect(received[2]).toMatchObject({
      seq: 3,
      type: "run.event",
    });
  });

  test("a cursor from another channel is ignored, not trusted", async () => {
    const events = new SessionEventRegistry<never>();

    events.startRun("session-1", "run-1");
    events.publish("session-1", "run-1", turnStart("turn-1"));

    // 序号比这条通道的还大，但 `epoch` 是别人的：仍然从运行开头重放。
    const received = await readEvents(
      events.subscribe("session-1", { epoch: "other", seq: 99 }),
      3
    );

    expect(received[1]?.type).toBe("run.start");
    expect(received[2]?.type).toBe("run.event");
  });

  test("drops a finished session with no readers", async () => {
    const events = new SessionEventRegistry<never>();

    events.startRun("session-1", "run-1");
    const head = await readEvents(events.subscribe("session-1"), 1);
    events.endRun("session-1", "run-1");
    await Promise.resolve();
    await Promise.resolve();

    // 通道被丢掉了，再来的人拿到一条新的：`epoch` 变了，读者据此重新读会话。
    const again = await readEvents(events.subscribe("session-1"), 1);
    expect(again[0]?.type).toBe("ready");
    expect(again[0]?.type === "ready" ? again[0].epoch : "").not.toBe(
      head[0]?.type === "ready" ? head[0].epoch : ""
    );
  });
});
