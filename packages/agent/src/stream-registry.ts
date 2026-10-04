import type { AgentStreamEvent } from "@workspace/agent-client/types";
import type { ToolSet } from "ai";

import type { Agent } from "./agents";

export class StreamEventRegistry<TOOLS extends ToolSet> {
  readonly #store = new Map<string, StreamEventEntry<TOOLS>>();

  registerStream(
    streamId: string,
    agent: Agent,
    stream: ReadableStream<AgentStreamEvent<TOOLS>>
  ): void {
    const entry = new StreamEventEntry(streamId, agent, stream);
    this.#store.set(streamId, entry);
    entry.start();
  }

  /**
   * The entry for a session's turn, found by session rather than by stream id
   * because a session id is what a client holds — the stream id names one
   * particular turn, and only the server ever needs to make that distinction.
   *
   * The newest match wins: a superseded turn stays registered until its own
   * finish unregisters it, and the one to stop or read is the one running now.
   */
  getStreamEntryBySession(
    sessionId: string
  ): StreamEventEntry<TOOLS> | undefined {
    let found: StreamEventEntry<TOOLS> | undefined;

    for (const entry of this.#store.values()) {
      if (entry.agent.sessionId === sessionId) {
        found = entry;
      }
    }

    return found;
  }

  unregisterStream(streamId: string): boolean {
    return this.#store.delete(streamId);
  }
}

type Subscriber<TOOLS extends ToolSet> = {
  onEvent: (event: AgentStreamEvent<TOOLS>) => void;
  onEnd: () => void;
  onError: (error: unknown) => void;
};

/**
 * One turn's events, held so that a reader can attach at any point.
 *
 * The turn is produced into a `ReadableStream` that a reader consumes as it
 * arrives, which is enough for the request that started the turn and useless to
 * anyone else: the chunks it read are gone, and the turn runs to completion
 * whether or not anyone is reading. So the entry reads that stream itself and
 * keeps what it read, and every reader works off the copy — one arriving late
 * gets the running turn from its start rather than whichever events happen to
 * follow.
 *
 * Only the running turn is kept. Every earlier turn is already in the store,
 * and the running one is not written until it finishes, so replaying from the
 * current `turn.start` is exactly what a reader needs and never duplicates what
 * it already has.
 */
export class StreamEventEntry<TOOLS extends ToolSet> {
  streamId: string;
  agent: Agent;

  readonly #source: ReadableStream<AgentStreamEvent<TOOLS>>;
  readonly #events: AgentStreamEvent<TOOLS>[] = [];
  readonly #subscribers = new Set<Subscriber<TOOLS>>();
  #done = false;
  #failure: unknown;

  constructor(
    streamId: string,
    agent: Agent,
    stream: ReadableStream<AgentStreamEvent<TOOLS>>
  ) {
    this.streamId = streamId;
    this.agent = agent;
    this.#source = stream;
  }

  /** Drains the source into the buffer, feeding whoever is reading. */
  start(): void {
    void (async () => {
      const reader = this.#source.getReader();

      try {
        while (true) {
          const { value, done } = await reader.read();

          if (done) {
            break;
          }

          this.#append(value);
        }
      } catch (error) {
        this.#failure = error;
      } finally {
        reader.releaseLock();
        this.#finish();
      }
    })();
  }

  /**
   * The turn from its start, then live until it ends.
   *
   * Each caller gets its own stream: several can read the same turn at once —
   * the page that started it and a page that reloaded into it — and one of them
   * going away neither ends the turn nor disturbs the others.
   */
  readable(): ReadableStream<AgentStreamEvent<TOOLS>> {
    let subscriber: Subscriber<TOOLS> | undefined;

    return new ReadableStream<AgentStreamEvent<TOOLS>>({
      start: (controller) => {
        for (const event of this.#events) {
          controller.enqueue(event);
        }

        if (this.#done) {
          this.#close(controller);
          return;
        }

        const self: Subscriber<TOOLS> = {
          onEvent: (event) => {
            try {
              controller.enqueue(event);
            } catch {
              // The reader is gone; stop feeding it.
              this.#subscribers.delete(self);
            }
          },
          onEnd: () => this.#close(controller),
          onError: (error) => {
            try {
              controller.error(error);
            } catch {
              // Already closed.
            }
          },
        };

        subscriber = self;
        this.#subscribers.add(self);
      },
      cancel: () => {
        if (subscriber) {
          this.#subscribers.delete(subscriber);
        }
      },
    });
  }

  #append(event: AgentStreamEvent<TOOLS>): void {
    if (event.type === "turn.start") {
      // A new turn supersedes whatever the previous one left buffered.
      this.#events.length = 0;
    }

    this.#events.push(event);

    for (const subscriber of this.#subscribers) {
      subscriber.onEvent(event);
    }
  }

  #finish(): void {
    this.#done = true;

    for (const subscriber of this.#subscribers) {
      if (this.#failure === undefined) {
        subscriber.onEnd();
      } else {
        subscriber.onError(this.#failure);
      }
    }

    this.#subscribers.clear();
    this.#events.length = 0;
  }

  #close(
    controller: ReadableStreamDefaultController<AgentStreamEvent<TOOLS>>
  ): void {
    try {
      controller.close();
    } catch {
      // Already closed.
    }
  }
}

export const STREAM_REGISTRY = new StreamEventRegistry();
