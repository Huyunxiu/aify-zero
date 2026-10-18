import type { SessionModel, TurnInsertModel, TurnModel } from "@workspace/db";

import type { AgentStore, SessionEndStatus } from ".";

/**
 * The store a subagent runs against.
 *
 * A subagent has no session row of its own — its transcript belongs to the
 * `task` part that delegated to it, which is what the parent turn is persisted
 * with. The runtime still needs a store to write to, though, so this one keeps
 * everything in memory and throws it away when the run ends.
 *
 * The session starts with a title on purpose: an empty one makes the runtime
 * ask the model to name the session, which would spend a call and put
 * `session.title.*` events on the parent's stream for a session nobody lists.
 *
 * The methods are promise-returning without being `async`: nothing here waits
 * on anything, and the interface the runtime is written against is async.
 */
export class MemoryAgentStore implements AgentStore {
  readonly #session: SessionModel;
  readonly #turns = new Map<string, TurnModel>();

  constructor({ sessionId, title }: { sessionId: string; title: string }) {
    const now = new Date();
    this.#session = {
      id: sessionId,
      title,
      metadata: {},
      activeHeadId: null,
      activeStreamId: null,
      status: "idle",
      forkedFromSessionId: null,
      forkedFromMessageId: null,
      createdAt: now,
      updatedAt: now,
    };
  }

  listSessions(): Promise<SessionModel[]> {
    return Promise.resolve([this.#session]);
  }

  saveSession(): Promise<boolean> {
    // The row exists from the constructor on, so there is never one to insert.
    return Promise.resolve(false);
  }

  updateSession(_sessionId: string, title: string): Promise<number> {
    this.#session.title = title;
    return Promise.resolve(1);
  }

  getSessionById(): Promise<SessionModel | null> {
    return Promise.resolve(this.#session);
  }

  updateSessionById(_sessionId: string, title: string): Promise<number> {
    this.#session.title = title;
    return Promise.resolve(1);
  }

  getAllTurnsBySessionId(): Promise<TurnModel[]> {
    return Promise.resolve([...this.#turns.values()]);
  }

  getBranchTurns(): Promise<TurnModel[]> {
    const path: TurnModel[] = [];
    let current = this.#session.activeHeadId
      ? this.#turns.get(this.#session.activeHeadId)
      : undefined;

    while (current) {
      path.unshift(current);
      current = current.parentId
        ? this.#turns.get(current.parentId)
        : undefined;
    }

    return Promise.resolve(path);
  }

  setActiveHead(
    _sessionId: string,
    messageId: string | undefined
  ): Promise<number> {
    this.#session.activeHeadId = messageId ?? null;
    return Promise.resolve(1);
  }

  setActiveStream(_sessionId: string, streamId: string): Promise<number> {
    this.#session.activeStreamId = streamId;
    this.#session.status = "running";
    return Promise.resolve(1);
  }

  clearActiveStream(
    _sessionId: string,
    streamId: string,
    status: SessionEndStatus
  ): Promise<number> {
    if (this.#session.activeStreamId !== streamId) {
      return Promise.resolve(0);
    }

    this.#session.activeStreamId = null;
    this.#session.status = status;
    return Promise.resolve(1);
  }

  markSessionRead(): Promise<number> {
    if (this.#session.status !== "done") {
      return Promise.resolve(0);
    }

    this.#session.status = "idle";
    return Promise.resolve(1);
  }

  existsTurn(id: string): Promise<boolean> {
    return Promise.resolve(this.#turns.has(id));
  }

  saveTurn(message: TurnInsertModel): Promise<number> {
    const { id } = message;
    if (!id) {
      throw new Error("A turn saved to the in-memory store needs an id.");
    }

    const existing = this.#turns.get(id);
    const now = new Date();

    this.#turns.set(id, {
      id,
      sessionId: message.sessionId ?? null,
      type: message.type,
      metadata: message.metadata ?? null,
      content: message.content,
      parentId: message.parentId ?? null,
      createdAt: message.createdAt ?? existing?.createdAt ?? now,
      updatedAt: now,
    });

    return Promise.resolve(1);
  }

  async saveTurns(messages: TurnInsertModel[]): Promise<number> {
    for (const message of messages) {
      await this.saveTurn(message);
    }
    return messages.length;
  }

  updateTurn(
    id: string,
    content: unknown,
    metadata?: unknown
  ): Promise<number> {
    const turn = this.#turns.get(id);
    if (!turn) {
      return Promise.resolve(0);
    }

    turn.content = content;
    if (metadata !== undefined) {
      turn.metadata = metadata;
    }
    turn.updatedAt = new Date();
    return Promise.resolve(1);
  }
}
