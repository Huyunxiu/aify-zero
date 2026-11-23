import type { AgentStreamEvent, AgentUserTurn } from "@workspace/agent-client";
import { describe, expect, test, vi } from "vitest";

import {
  TitleExtension,
  sessionTitle,
} from "../src/extensions/builtin/title.js";
import { Capabilities } from "../src/extensions/capabilities.js";
import type { ExtensionAPI } from "../src/extensions/types.js";
import { HooksManager } from "../src/hooks-manager.js";
import type {
  GeneratedText,
  ModelGateway,
} from "../src/kernel/model-gateway.js";
import { ZERO_USAGE } from "../src/kernel/usage.js";
import type { AgentStore } from "../src/storage/index.js";
import type { AgentToolSet } from "../src/types.js";
import { asTurns, userTurn } from "./compaction/fixtures.js";

const generated = (text: string): GeneratedText => ({
  text,
  usage: ZERO_USAGE,
  finishReason: "stop",
});

const userTurns = () => asTurns(userTurn("u1", "what is the weather in NYC"));

/** 一条定时器到点的回合：它是 user turn，但 step 上带着系统来源。 */
const timerTurn = (id: string): AgentUserTurn => {
  const turn = userTurn(id, "timer fired");
  return {
    ...turn,
    content: turn.content.map((step) => ({
      ...step,
      source: "timer" as const,
    })),
  };
};

/** turn_created 事件的替身；标题任务只读 sessionId、turnId 和 model。 */
const turnCreatedEvent = {
  sessionId: "s1",
  turnId: "t1",
  model: { providerId: "test-provider", modelId: "m1" },
};

/** 只实现标题路径用到的读写。 */
const makeStore = (existing: string | undefined) => {
  const titles: string[] = [];
  const store = {
    getSessionById: () =>
      Promise.resolve(existing === undefined ? null : { title: existing }),
    updateSessionById: (_id: string, title: string) => {
      titles.push(title);
      return Promise.resolve(1);
    },
  };
  return { store: store as unknown as AgentStore, titles };
};

/** 用替身 capability 装一个扩展，并收集它注册的 hook 处理器。 */
const install = async (
  extension: TitleExtension,
  deps: ReadonlyMap<string, unknown>
) => {
  const handlers = new Map<string, (event: unknown, api: unknown) => unknown>();
  const api = {
    use: (token: { id: string }) => deps.get(token.id),
    on: (name: string, handler: (event: unknown, api: unknown) => unknown) => {
      handlers.set(name, handler);
    },
  } as unknown as ExtensionAPI;

  await Promise.resolve(extension.init(api));
  return handlers;
};

describe(TitleExtension, () => {
  test("writes the generated title and its protocol events", async () => {
    const { store, titles } = makeStore("");
    const events: AgentStreamEvent<AgentToolSet>[] = [];
    const model: ModelGateway = {
      languageModel: () => {
        throw new Error("the title task does not stream");
      },
      generateText: () => Promise.resolve(generated("Weather in NYC")),
    };
    const hooks = new HooksManager();

    const handlers = await install(
      new TitleExtension({ id: "title" }),
      new Map<string, unknown>([
        [Capabilities.model.id, model],
        [Capabilities.store.id, store],
        [
          Capabilities.events.id,
          {
            write: (event: AgentStreamEvent<AgentToolSet>) => {
              events.push(event);
              return Promise.resolve();
            },
          },
        ],
        [Capabilities.hooks.id, hooks],
        [Capabilities.transcript.id, { turns: userTurns }],
        [Capabilities.abortSignal.id, () => {}],
      ])
    );

    const turnCreated = handlers.get("turn_created");
    expect(turnCreated).toBeDefined();
    turnCreated?.(turnCreatedEvent, {});

    await vi.waitFor(() => {
      expect(titles).toStrictEqual(["Weather in NYC"]);
    });

    expect(events.map((event) => event.type)).toStrictEqual([
      "step.start",
      "session.title.start",
      "session.title.end",
      "step.finish",
    ]);
  });

  test("skips a timer notice and takes the earlier user turn", async () => {
    const { store } = makeStore("");
    const prompts: string[] = [];
    const model: ModelGateway = {
      languageModel: () => {
        throw new Error("the title task does not stream");
      },
      generateText: (_ref, request) => {
        prompts.push(request.prompt);
        return Promise.resolve(generated("Weather in NYC"));
      },
    };

    const handlers = await install(
      new TitleExtension({ id: "title" }),
      new Map<string, unknown>([
        [Capabilities.model.id, model],
        [Capabilities.store.id, store],
        [Capabilities.events.id, { write: () => Promise.resolve() }],
        [Capabilities.hooks.id, new HooksManager()],
        [
          Capabilities.transcript.id,
          {
            turns: () =>
              asTurns(
                userTurn("u1", "what is the weather in NYC"),
                timerTurn("u2")
              ),
          },
        ],
        [Capabilities.abortSignal.id, () => {}],
      ])
    );

    handlers.get("turn_created")?.(turnCreatedEvent, {});

    // 定时器到点不是用户说的话：取样的仍是 u1 的正文，不是 timer 那一行。
    await vi.waitFor(() => {
      expect(prompts).toHaveLength(1);
    });
    expect(prompts[0]).toContain("what is the weather in NYC");
    expect(prompts[0]).not.toContain("timer fired");
  });

  test("keeps the title inside the limit the prompt asks for", async () => {
    const { store, titles } = makeStore("");
    const model: ModelGateway = {
      languageModel: () => {
        throw new Error("the title task does not stream");
      },
      generateText: () =>
        Promise.resolve(
          generated(
            "  User   asking about\n the weather in New York City, in detail  "
          )
        ),
    };

    const handlers = await install(
      new TitleExtension({ id: "title" }),
      new Map<string, unknown>([
        [Capabilities.model.id, model],
        [Capabilities.store.id, store],
        [Capabilities.events.id, { write: () => Promise.resolve() }],
        [Capabilities.hooks.id, new HooksManager()],
        [Capabilities.transcript.id, { turns: userTurns }],
        [Capabilities.abortSignal.id, () => {}],
      ])
    );

    handlers.get("turn_created")?.(turnCreatedEvent, {});

    // The prompt asks for one short line. A prompt is not a check: a model that
    // answers with a paragraph still has to land inside the limit.
    await vi.waitFor(() => {
      expect(titles).toStrictEqual(["User asking about the weather"]);
    });
  });

  test("cuts the title on a character boundary", () => {
    const family = "👩‍👩‍👧‍👦";
    const kept = `${"a".repeat(29)}${family}`;

    // The family is one character to a reader and seven code points to a string.
    expect(sessionTitle(`${kept}b`)).toBe(kept);
  });

  test("keeps an existing title", async () => {
    const { store, titles } = makeStore("Named by the caller");
    const generateText = vi.fn<() => Promise<GeneratedText>>(() =>
      Promise.resolve(generated("ignored"))
    );

    const handlers = await install(
      new TitleExtension({ id: "title" }),
      new Map<string, unknown>([
        [
          Capabilities.model.id,
          {
            languageModel: () => {
              throw new Error("the title task does not stream");
            },
            generateText,
          },
        ],
        [Capabilities.store.id, store],
        [Capabilities.events.id, { write: () => Promise.resolve() }],
        [Capabilities.hooks.id, new HooksManager()],
        [Capabilities.transcript.id, { turns: userTurns }],
        [Capabilities.abortSignal.id, () => {}],
      ])
    );

    handlers.get("turn_created")?.(turnCreatedEvent, {});

    // 处理器的第一件事是读会话行；等它跑完这一轮再断言。
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });

    expect(generateText).not.toHaveBeenCalled();
    expect(titles).toStrictEqual([]);
  });
});
