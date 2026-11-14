import type { AgentStreamEvent } from "@workspace/agent-client";
import { describe, expect, test, vi } from "vitest";

import { TitleExtension } from "../src/extensions/builtin/title.js";
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
