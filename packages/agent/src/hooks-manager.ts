import type { ModelMessage } from "ai";

/**
 * 传给 hook 处理器的第二个参数。它属于插件系统而不是 Agent：故意保持独立
 * 类型（永远不是 `AgentContext`），由拥有 hooks 的宿主在 emit 时传入。
 */
export type HookContext = {};

export type SessionStartEvent = {
  sessionId: string;
  name: string;
  /** 项目目录列表，第一项是主目录。 */
  projectDirs: readonly string[];
  sessionDir: string;
};

export type SessionEndEvent = {
  sessionId: string;
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
 * One tool call, about to run. Shared by the `tool:before` and `tool:after`
 * events: the fields describing the call are the same either way, and only the
 * outcome of having run it differs.
 */
export type ToolCallHookEvent = {
  sessionId: string;
  turnId: string;
  stepId: string;
  toolCallId: string;
  toolName: string;
  /**
   * The input the tool is called with. `tool:after` reports the input that was
   * actually executed, which a `tool:before` handler may have rewritten.
   */
  input: unknown;
  /**
   * The messages that prompted the call — the system prompt and this step's own
   * assistant message are not among them, matching what the tool itself sees.
   */
  messages: ModelMessage[];
};

/**
 * What a `tool:before` handler may return. Returning `undefined` (or `null`)
 * abstains, so a handler that only cares about side effects leaves the call as
 * it is. Every handler has a veto: a refusal anywhere in the run is the run's
 * answer, an `ask` stands over an `allow` — the user is not asked to overrule a
 * hook — and only a run in which nobody had an opinion leaves the call alone.
 * See `resolveToolBeforeDecision`, which does the folding.
 */
export type ToolBeforeDecision =
  | { decision: "allow" }
  | { decision: "deny"; reason?: string }
  | { decision: "ask" };

export type ToolAfterEvent = ToolCallHookEvent & {
  outcome: "result" | "error" | "denied";
  /** The tool's return value when it produced one. */
  output?: unknown;
  /** Why the call failed, when it did. */
  errorText?: string;
  durationMs: number;
};

/**
 * The text a denied tool call reports to the model. Spelled here rather than
 * inline because the same wording has to be produced when the turn is rebuilt
 * from stored parts — see `convert-to-model-message.ts`.
 */
export const TOOL_DENIED_TEXT = "Tool call execution denied.";

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
  /**
   * Raised once per client tool call, before it runs. This is the only place a
   * call can be turned down or its input rewritten: the tools are executed by
   * the agent loop, not by the SDK, precisely so that this point exists.
   */
  "tool:before": HookHandler<ToolCallHookEvent, ToolBeforeDecision>;
  "tool:after": HookHandler<ToolAfterEvent>;
}

/**
 * A hook for one event. `R` is what the handler may return; the built-in
 * events ignore it, but hosts that act on hook results can type it. Returning
 * `undefined` (or `null`) means "no opinion": {@link HooksManager.emit} then
 * falls back to what an earlier handler returned.
 */
export type HookHandler<T, R = unknown> = (
  event: T,
  api: HookContext
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
 * Every value the handlers of `K` produced during one run, in the order they
 * ran. Nullish returns are dropped, so a handler that only cared about side
 * effects contributes nothing — see {@link HooksManager.emitAsyncHooks}.
 *
 * `Exclude` rather than `NonNullable`: the latter collapses `unknown` — the
 * return type of a handler registered without an `R` — to `{}`.
 */
export type HookResultsOf<K extends HookEventName> = Exclude<
  HookResultOf<K>,
  null | undefined
>[];

/**
 * Stored form of a registration: the event type is erased because listeners of
 * every event share one map, and `source` keeps the original handler so that
 * `off` can match it by identity.
 */
type Listener = {
  run: (event: unknown, api: HookContext) => unknown;
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
 * instead of clearing it. `emitAsyncHooks` runs the same handlers but keeps
 * every value instead of collapsing them into one.
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
    api: HookContext
  ): Promise<HookResultOf<K>> {
    const results = await this.dispatch(name, event, api);
    // Walk backwards so the last handler to have an opinion wins; a nullish
    // value abstains and is skipped rather than clearing an earlier one.
    for (let i = results.length - 1; i >= 0; i -= 1) {
      const value = results[i];
      if (value !== undefined && value !== null) {
        return value as HookResultOf<K>;
      }
    }
    return undefined;
  }

  /**
   * Delivers `event` to every handler registered for `name`, exactly like
   * {@link emit}, and resolves with all of their return values in the order
   * the handlers ran.
   *
   * Where `emit` keeps only the last opinion, this keeps every one of them, so
   * a caller that needs to collect or merge contributions — rather than pick a
   * decision — does not have to smuggle an accumulator into a closure.
   *
   * Handlers that abstain (`undefined`/`null`) or throw contribute nothing, so
   * the array can be shorter than the number of handlers.
   */
  async emitAsyncHooks<K extends HookEventName>(
    name: K,
    event: HookEventOf<K>,
    api: HookContext
  ): Promise<HookResultsOf<K>> {
    const results = await this.dispatch(name, event, api);
    return results.filter(
      (value) => value !== undefined && value !== null
    ) as HookResultsOf<K>;
  }

  /**
   * Runs the handlers of `name` in priority order and returns what each of
   * them returned, nullish values included. A handler that throws is reported
   * and skipped, leaving no entry behind.
   */
  private async dispatch(
    name: string,
    event: HookEventOf<HookEventName>,
    api: HookContext
  ): Promise<unknown[]> {
    const listeners = this.listeners.get(name);
    if (!listeners || listeners.length === 0) {
      return [];
    }

    const results: unknown[] = [];

    // Every mutation swaps in a fresh array, so this one stays stable even if
    // a handler subscribes or unsubscribes while we dispatch.
    for (const listener of listeners) {
      if (listener.once) {
        this.remove(name, listener);
      }

      try {
        results.push(await listener.run(event, api));
      } catch (error) {
        console.warn(`[hooks] "${name}" handler failed:`, error);
      }
    }

    return results;
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
