import type {
  AgentStreamEvent,
  SessionStreamEvent,
} from "@workspace/agent-client";
import { describe, expect, test, vi } from "vitest";

import type { Agent } from "../src/agents.js";
import { SessionEventRegistry } from "../src/session-events.js";
import {
  StreamEventEntry,
  StreamEventRegistry,
} from "../src/stream-registry.js";
import type { AgentToolSet } from "../src/types.js";

// The lookup only ever reads `agent.sessionId`, and unregistering calls
// `agent.dispose`; the rest of the agent is irrelevant here.
const agentOf = (sessionId: string): Agent =>
  ({ sessionId, dispose: () => Promise.resolve() }) as unknown as Agent;

type TestEvent = AgentStreamEvent<AgentToolSet>;

// The entry only reads `event.type`, so the rest of the event is irrelevant.
const turnStart = (turnId: string): TestEvent =>
  ({
    type: "turn.start",
    turnType: "assistant",
    turnId,
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
    fail: (reason: unknown): void => controller.error(reason),
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
    const registry = new StreamEventRegistry(new SessionEventRegistry());
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
    const registry = new StreamEventRegistry(new SessionEventRegistry());
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

  test("drops an entry once it is unregistered", async () => {
    const registry = new StreamEventRegistry(new SessionEventRegistry());
    registry.registerStream(
      "stream-a",
      agentOf("session-1"),
      new ReadableStream()
    );

    await registry.unregisterStream("stream-a");

    expect(registry.getStreamEntryBySession("session-1")).toBeUndefined();
  });

  test("releases the agent that ran the stream", async () => {
    const registry = new StreamEventRegistry(new SessionEventRegistry());
    const dispose = vi.fn<() => Promise<void>>(() => Promise.resolve());
    const agent = { sessionId: "session-1", dispose } as unknown as Agent;

    registry.registerStream("stream-a", agent, new ReadableStream());
    await registry.unregisterStream("stream-a");

    expect(dispose).toHaveBeenCalledOnce();
  });
});

// A reader that attaches part-way through a turn is the reload case: the page
// that started the turn is gone, and this one has to see the whole turn.
describe(StreamEventEntry, () => {
  test("replays the running turn and then follows it live", async () => {
    const registry = new StreamEventRegistry<AgentToolSet>(
      new SessionEventRegistry()
    );
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
    const registry = new StreamEventRegistry<AgentToolSet>(
      new SessionEventRegistry()
    );
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
    const registry = new StreamEventRegistry<AgentToolSet>(
      new SessionEventRegistry()
    );
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

// Stopping is what reads these: `isDone` says whether there is a turn left to
// stop, and `whenFinished` is what the stop awaits before it answers.
describe(`${StreamEventEntry.name} lifetime`, () => {
  test("is not done while its source is open, and settles when it ends", async () => {
    const registry = new StreamEventRegistry<AgentToolSet>(
      new SessionEventRegistry()
    );
    const producer = source();
    registry.registerStream("stream-a", agentOf("session-1"), producer.stream);
    await tick();

    const entry = registry.getStreamEntryBySession("session-1")!;
    const finished = entry.whenFinished();

    expect(entry.isDone()).toBeFalsy();

    producer.close();
    await finished;

    expect(entry.isDone()).toBeTruthy();
  });

  test("settles even when its source fails", async () => {
    const registry = new StreamEventRegistry<AgentToolSet>(
      new SessionEventRegistry()
    );
    const producer = source();
    registry.registerStream("stream-a", agentOf("session-1"), producer.stream);
    await tick();

    const entry = registry.getStreamEntryBySession("session-1")!;
    const finished = entry.whenFinished();

    producer.fail(new Error("the stream broke"));
    await finished;

    expect(entry.isDone()).toBeTruthy();
  });
});

describe("SessionEventRegistry wiring", () => {
  test("a registered stream is one run on the session's event stream", async () => {
    const channels = new SessionEventRegistry<AgentToolSet>();
    const registry = new StreamEventRegistry<AgentToolSet>(channels);
    const reader = channels.subscribe("session-1").getReader();

    const producer = source();
    registry.registerStream("stream-a", agentOf("session-1"), producer.stream, {
      turnId: "turn-1",
    });

    producer.push(turnStart("turn-1"));
    producer.push(textDelta("hi"));
    await tick();
    producer.close();

    const received: SessionStreamEvent<AgentToolSet>[] = [];
    for (let index = 0; index < 5; index += 1) {
      const { value } = await reader.read();
      received.push(value!);
    }
    await reader.cancel();

    expect(received.map((event) => event.type)).toStrictEqual([
      "ready",
      "run.start",
      "run.event",
      "run.event",
      "run.end",
    ]);
    expect(received[1]).toMatchObject({
      streamId: "stream-a",
      turnId: "turn-1",
    });
  });

  test("a stream that fails ends its run with the reason", async () => {
    const channels = new SessionEventRegistry<AgentToolSet>();
    const registry = new StreamEventRegistry<AgentToolSet>(channels);
    const reader = channels.subscribe("session-1").getReader();

    const producer = source();
    registry.registerStream("stream-a", agentOf("session-1"), producer.stream);
    await tick();
    producer.fail(new Error("model exploded"));
    await tick();

    const received: SessionStreamEvent<AgentToolSet>[] = [];
    for (let index = 0; index < 3; index += 1) {
      const { value } = await reader.read();
      received.push(value!);
    }
    await reader.cancel();

    expect(received.at(-1)).toMatchObject({
      failure: "model exploded",
      type: "run.end",
    });
  });
});
