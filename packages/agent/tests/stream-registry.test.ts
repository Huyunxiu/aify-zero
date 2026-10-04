import type { AgentStreamEvent } from "@workspace/agent-client/types";
import { describe, expect, test } from "vitest";

import type { Agent } from "../src/agents.js";
import {
  StreamEventEntry,
  StreamEventRegistry,
} from "../src/stream-registry.js";
import type { AgentToolSet } from "../src/types.js";

// The lookup only ever reads `agent.sessionId`, so the rest of the agent is
// irrelevant here.
const agentOf = (sessionId: string): Agent =>
  ({ sessionId }) as unknown as Agent;

type TestEvent = AgentStreamEvent<AgentToolSet>;

// The entry only reads `event.type`, so the rest of the event is irrelevant.
const turnStart = (id: string): TestEvent =>
  ({
    type: "turn.start",
    turnType: "assistant",
    id,
    createdAt: 0,
  }) as TestEvent;

const textDelta = (text: string): TestEvent =>
  ({
    type: "text.delta",
    turnId: "turn-1",
    stepId: "step-1",
    id: "part-1",
    text,
  }) as TestEvent;

/** A source the test drives by hand, standing in for the agent's producer. */
const source = () => {
  let controller!: ReadableStreamDefaultController<TestEvent>;

  const stream = new ReadableStream<TestEvent>({
    start: (controllerArg) => {
      controller = controllerArg;
    },
  });

  return {
    stream,
    push: (event: TestEvent): void => controller.enqueue(event),
    close: (): void => controller.close(),
  };
};

const drain = async (
  reader: ReadableStreamDefaultReader<TestEvent>
): Promise<TestEvent[]> => {
  const received: TestEvent[] = [];

  while (true) {
    const { value, done } = await reader.read();

    if (done) {
      return received;
    }

    received.push(value);
  }
};

// The pump drains the source on its own turn of the event loop.
const tick = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

describe(StreamEventRegistry, () => {
  test("finds an entry by its session and misses an unknown one", () => {
    const registry = new StreamEventRegistry();
    registry.registerStream(
      "stream-a",
      agentOf("session-1"),
      new ReadableStream()
    );
    registry.registerStream(
      "stream-b",
      agentOf("session-2"),
      new ReadableStream()
    );

    expect(registry.getStreamEntryBySession("session-1")?.streamId).toBe(
      "stream-a"
    );
    expect(registry.getStreamEntryBySession("session-2")?.streamId).toBe(
      "stream-b"
    );
    expect(registry.getStreamEntryBySession("session-3")).toBeUndefined();
  });

  // A superseded turn stays registered until its own finish unregisters it, and
  // the one running now is the one to read or stop.
  test("prefers the newest entry when a session has two", () => {
    const registry = new StreamEventRegistry();
    registry.registerStream(
      "older",
      agentOf("session-1"),
      new ReadableStream()
    );
    registry.registerStream(
      "newer",
      agentOf("session-1"),
      new ReadableStream()
    );

    expect(registry.getStreamEntryBySession("session-1")?.streamId).toBe(
      "newer"
    );
  });

  test("drops an entry once it is unregistered", () => {
    const registry = new StreamEventRegistry();
    registry.registerStream(
      "stream-a",
      agentOf("session-1"),
      new ReadableStream()
    );

    registry.unregisterStream("stream-a");

    expect(registry.getStreamEntryBySession("session-1")).toBeUndefined();
  });
});

// A reader that attaches part-way through a turn is the reload case: the page
// that started the turn is gone, and this one has to see the whole turn.
describe(StreamEventEntry, () => {
  test("replays the running turn and then follows it live", async () => {
    const registry = new StreamEventRegistry<AgentToolSet>();
    const producer = source();
    registry.registerStream("stream-a", agentOf("session-1"), producer.stream);

    producer.push(turnStart("turn-1"));
    producer.push(textDelta("hello"));
    await tick();

    const entry = registry.getStreamEntryBySession("session-1");
    const reader = entry!.readable().getReader();

    producer.push(textDelta(" world"));
    await tick();
    producer.close();

    await expect(drain(reader)).resolves.toStrictEqual([
      turnStart("turn-1"),
      textDelta("hello"),
      textDelta(" world"),
    ]);
  });

  test("buffers only the turn that is running", async () => {
    const registry = new StreamEventRegistry<AgentToolSet>();
    const producer = source();
    registry.registerStream("stream-a", agentOf("session-1"), producer.stream);

    producer.push(turnStart("turn-1"));
    producer.push(textDelta("earlier"));
    await tick();
    producer.push(turnStart("turn-2"));
    await tick();

    const entry = registry.getStreamEntryBySession("session-1");
    const reader = entry!.readable().getReader();
    producer.close();

    await expect(drain(reader)).resolves.toStrictEqual([turnStart("turn-2")]);
  });

  test("feeds every reader of a turn", async () => {
    const registry = new StreamEventRegistry<AgentToolSet>();
    const producer = source();
    registry.registerStream("stream-a", agentOf("session-1"), producer.stream);
    await tick();

    const entry = registry.getStreamEntryBySession("session-1");
    const first = entry!.readable().getReader();
    const second = entry!.readable().getReader();

    producer.push(textDelta("shared"));
    await tick();
    producer.close();

    await expect(drain(first)).resolves.toStrictEqual([textDelta("shared")]);
    await expect(drain(second)).resolves.toStrictEqual([textDelta("shared")]);
  });
});
