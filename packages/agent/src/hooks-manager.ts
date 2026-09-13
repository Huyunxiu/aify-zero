import type { ModelMessage } from "ai";

/**
 * The API surface handed to a hook as its second argument. It belongs to the
 * plugin system, not to the agent: it is deliberately its own type — never
 * `AgentContext` — and the host that owns the hooks passes it on emit.
 */
export type ExtensionAPI = {};

export type SessionStartEvent = {
  sessionId: string;
  name: string;
  workdir: string;
};

export type SessionEndEvent = {
  sessionId: string;
  messageId: string;
};

export type TitleGeneratedEvent = {
  sessionId: string;
  title: string;
};

export type CompactionStartEvent = {
  sessionId: string;
  createdAt: number;
};

export type CompactionEndEvent = {
  sessionId: string;
  compacted: boolean;
  messages: ModelMessage[];
  createdAt: number;
};

/**
 * Registry of every hookable event, mapping an event name to the handler that
 * listens for it. Custom events are added by declaration merging, which keeps
 * `on()` fully typed:
 *
 * ```ts
 * declare module "@workspace/agent/hooks-manager" {
 *   interface HooksMap {
 *     "tool_called": HookHandler<{ toolName: string }>;
 *   }
 * }
 * ```
 */
export interface HooksMap {
  session_start: HookHandler<SessionStartEvent>;
  session_end: HookHandler<SessionEndEvent>;
  title_generated: HookHandler<TitleGeneratedEvent>;
  "compaction:start": HookHandler<CompactionStartEvent>;
  "compaction:end": HookHandler<CompactionEndEvent>;
}

/**
 * A hook for one event. `R` is what the handler may return; the built-in
 * events ignore it, but hosts that act on hook results can type it. Returning
 * `undefined` (or `null`) means "no opinion": {@link HooksManager.emit} then
 * falls back to what an earlier handler returned.
 */
export type HookHandler<T, R = unknown> = (
  event: T,
  api: ExtensionAPI
) => Promise<R> | R | undefined;

export type HookOptions = {
  /**
   * Ordering among the handlers of one event: higher runs first. Handlers
   * sharing a priority run in registration order. Defaults to 0.
   */
  priority?: number;
};

export type HookEventName = keyof HooksMap & string;

/** The payload a handler of `K` receives, e.g. `SessionStartEvent`. */
export type HookEventOf<K extends HookEventName> = Parameters<HooksMap[K]>[0];

/**
 * The `R` the handlers of `K` return, which is what {@link HooksManager.emit}
 * resolves with. `undefined` is spelled out because a run where no handler
 * produced a value resolves with nothing, and because `HookHandler` may always
 * abstain — writing it here keeps the generic honest to the type checker.
 */
export type HookResultOf<K extends HookEventName> =
  | Awaited<ReturnType<HooksMap[K]>>
  | undefined;

/**
 * Stored form of a registration: the event type is erased because listeners of
 * every event share one map, and `source` keeps the original handler so that
 * `off` can match it by identity.
 */
type Listener = {
  run: (event: unknown, api: ExtensionAPI) => unknown;
  once: boolean;
  priority: number;
  source: unknown;
};

const DEFAULT_PRIORITY = 0;

/**
 * Typed registry of lifecycle hooks.
 *
 * ```ts
 * const hooks = new HooksManager();
 * const off = hooks.on("session_start", (event, api) => {
 *   console.log(event.sessionId, api);
 * });
 * off(); // unsubscribe
 *
 * await hooks.emit("session_start", event, api); // by the hook owner
 * ```
 *
 * Handlers run sequentially, from the highest priority down, and each one is
 * awaited before the next starts. A handler that throws is reported and
 * skipped so that a single broken hook can never break the agent.
 *
 * `emit` resolves with the result of the run: the last value a handler
 * returned, since a handler that returns `undefined` or `null` abstains
 * instead of clearing it.
 */
export class HooksManager {
  private readonly listeners = new Map<string, Listener[]>();

  /** Registers `handler` for `name` and returns its unsubscribe function. */
  on<K extends HookEventName>(
    name: K,
    handler: HooksMap[K],
    options?: HookOptions
  ): () => void {
    return this.add(name, handler, false, options);
  }

  /** Like {@link on}, but the handler is removed right before it runs once. */
  once<K extends HookEventName>(
    name: K,
    handler: HooksMap[K],
    options?: HookOptions
  ): () => void {
    return this.add(name, handler, true, options);
  }

  /**
   * Removes registrations: everything when called empty, every handler of
   * `name` when called with just the event name, or only `handler`.
   */
  off<K extends HookEventName>(name?: K, handler?: HooksMap[K]): void {
    if (name === undefined) {
      this.listeners.clear();
      return;
    }

    const listeners = this.listeners.get(name);
    if (!listeners) {
      return;
    }

    if (handler === undefined) {
      this.listeners.delete(name);
      return;
    }

    const kept = listeners.filter((listener) => listener.source !== handler);
    if (kept.length === 0) {
      this.listeners.delete(name);
      return;
    }

    this.listeners.set(name, kept);
  }

  /**
   * Delivers `event` to every handler registered for `name` and resolves with
   * the result of the run.
   *
   * A handler that returns `undefined` or `null` abstains, so the value an
   * earlier handler produced stays the answer — `emit` therefore resolves with
   * the last non-nullish return value, or `undefined` when no handler had one.
   * A handler that throws abstains the same way.
   *
   * The resolved type is the event's {@link HookResultOf}, i.e. the `R` its
   * handlers were registered with.
   */
  async emit<K extends HookEventName>(
    name: K,
    event: HookEventOf<K>,
    api: ExtensionAPI
  ): Promise<HookResultOf<K>> {
    const listeners = this.listeners.get(name);
    if (!listeners || listeners.length === 0) {
      return undefined;
    }

    let result: unknown;

    // Every mutation swaps in a fresh array, so this one stays stable even if
    // a handler subscribes or unsubscribes while we dispatch.
    for (const listener of listeners) {
      if (listener.once) {
        this.remove(name, listener);
      }

      try {
        const value = await listener.run(event, api);
        if (value !== undefined && value !== null) {
          result = value;
        }
      } catch (error) {
        console.warn(`[hooks] "${name}" handler failed:`, error);
      }
    }

    // `listener.run` erases the result type along with the payload; `emit` is
    // the only place that pairs a name with its handlers, so it owns the cast.
    return result as HookResultOf<K>;
  }

  private add<K extends HookEventName>(
    name: K,
    handler: HooksMap[K],
    once: boolean,
    options?: HookOptions
  ): () => void {
    // `HooksMap` erases which payload each name carries, so widen the stored
    // signature; `emit` is the only caller and pairs name with its payload.
    const run = handler as HookHandler<unknown>;

    const listener: Listener = {
      run,
      once,
      priority: options?.priority ?? DEFAULT_PRIORITY,
      source: handler,
    };

    const next = [...(this.listeners.get(name) ?? [])];
    // Insert after the handlers of equal priority so that same-priority
    // handlers keep their registration order.
    const at = next.findIndex((e) => e.priority < listener.priority);
    if (at === -1) {
      next.push(listener);
    } else {
      next.splice(at, 0, listener);
    }
    // Copy-on-write: an `emit` in flight keeps iterating the array it read,
    // so registering here cannot disturb it.
    this.listeners.set(name, next);

    return () => this.remove(name, listener);
  }

  private remove(name: string, listener: Listener): void {
    const listeners = this.listeners.get(name);
    if (!listeners) {
      return;
    }

    const kept = listeners.filter((e) => e !== listener);
    if (kept.length === 0) {
      this.listeners.delete(name);
      return;
    }

    this.listeners.set(name, kept);
  }
}
