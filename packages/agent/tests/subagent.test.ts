import type { AgentTurn } from "@workspace/agent-client";
import type {
  SessionInsertModel,
  SessionModel,
  TurnModel,
} from "@workspace/db";
import { describe, expect, test } from "vitest";

import { AgentContext } from "../src/agent-context.js";
import { AgentSession } from "../src/agent-session.js";
import { Agent } from "../src/agents.js";
import type { ContextFile } from "../src/context-files.js";
import { renderProjectContext } from "../src/context-files.js";
import { SkillManager } from "../src/skill/index.js";
import type { AgentStore } from "../src/storage/index.js";
import {
  buildPromptTurn,
  createSubagent,
  readSubagentResult,
  resolveSubagentSession,
  selectSubagentTools,
} from "../src/subagent/create.js";
import type { SubagentDefinition } from "../src/subagent/definitions.js";
import type { AgentToolSet } from "../src/types.js";

/**
 * 只实现 resolveSubagentSession 真正用到的那三个方法。
 *
 * 这个测试不碰数据库：仓库里没有任何测试会连真实 sqlite，为一个函数引入
 * libsql 测试基建不划算。其余方法用不到，所以不实现。
 */
class FakeStore {
  readonly saved: SessionInsertModel[] = [];
  readonly #byParentToolCall = new Map<string, SessionModel>();
  readonly #turns = new Map<string, TurnModel[]>();

  /** 预置一个"已经派生过"的子会话，模拟父 turn 被 resume 时的场景。 */
  seedChild(
    parentSessionId: string,
    toolCallId: string,
    turns: AgentTurn<AgentToolSet>[]
  ): string {
    const id = `child-${this.#byParentToolCall.size}`;
    this.#byParentToolCall.set(`${parentSessionId}/${toolCallId}`, {
      id,
    } as SessionModel);
    this.#turns.set(
      id,
      turns.map((turn) => ({ content: turn }) as TurnModel)
    );
    return id;
  }

  findSessionByParentToolCall({
    parentSessionId,
    toolCallId,
  }: {
    parentSessionId: string;
    toolCallId: string;
  }): Promise<SessionModel | null> {
    return Promise.resolve(
      this.#byParentToolCall.get(`${parentSessionId}/${toolCallId}`) ?? null
    );
  }

  saveSession(session: SessionInsertModel): Promise<boolean> {
    this.saved.push(session);
    return Promise.resolve(true);
  }

  getBranchTurns(sessionId: string): Promise<TurnModel[]> {
    return Promise.resolve(this.#turns.get(sessionId) ?? []);
  }
}

const asStore = (store: FakeStore): AgentStore =>
  store as unknown as AgentStore;

const definition: SubagentDefinition = {
  name: "explore",
  description: "Read-heavy agent.",
  instructions: "Find things.",
};

/** task 调用里那句给用户看的短描述，落库时就是子会话的 title。 */
const taskLabel = "Find the thing";

const assistantTurn = (
  text: string,
  status: "done" | "error" = "done"
): AgentTurn<AgentToolSet> =>
  ({
    id: "turn-assistant",
    type: "assistant",
    createdAt: 0,
    status,
    content: [
      {
        id: "step-1",
        type: "assistant",
        createdAt: 0,
        status: "done",
        model: "test",
        content: [{ type: "text", text, state: "done", createdAt: 0 }],
      },
    ],
  }) as AgentTurn<AgentToolSet>;

/** 取出 prompt turn 里那段文本，断言时用。 */
const textOf = (turn: AgentTurn<AgentToolSet>): string | undefined => {
  const [step] = turn.content;
  const [part] = step?.content ?? [];
  return part?.type === "text" ? part.text : undefined;
};

describe(resolveSubagentSession, () => {
  test("creates a child session when the call has not run before", async () => {
    const store = new FakeStore();

    const { sessionId, turns } = await resolveSubagentSession(asStore(store), {
      parentSessionId: "parent-1",
      toolCallId: "call-1",
      description: taskLabel,
      prompt: "Find the thing.",
    });

    expect(store.saved).toHaveLength(1);
    expect(store.saved[0]).toMatchObject({
      id: sessionId,
      kind: "subagent",
      parentSessionId: "parent-1",
      parentToolCallId: "call-1",
    });
    // title 必须非空：运行时读这一行来决定要不要生成标题，读到空标题就会为
    // 一个没人看的会话白花一次模型调用。取的是 task 调用里那句短描述，因为
    // 那是这行唯一的可读标签。
    expect(store.saved[0]?.title).toBe(taskLabel);

    expect(turns.map((turn) => [turn.type, textOf(turn)])).toStrictEqual([
      ["user", "Find the thing."],
    ]);
  });

  test("reuses the existing child session instead of starting over", async () => {
    const store = new FakeStore();
    const existingId = store.seedChild("parent-1", "call-1", [
      buildPromptTurn("Find the thing."),
      assistantTurn("Found it."),
    ]);

    const { sessionId, turns } = await resolveSubagentSession(asStore(store), {
      parentSessionId: "parent-1",
      toolCallId: "call-1",
      description: taskLabel,
      prompt: "Find the thing.",
    });

    expect(sessionId).toBe(existingId);
    // 复用路径不该再插一行，也不该把 prompt turn 追加第二遍。
    expect(store.saved).toHaveLength(0);
    expect(turns).toHaveLength(2);
    expect(turns[0] && textOf(turns[0])).toBe("Find the thing.");
    expect(readSubagentResult(turns).report).toBe("Found it.");
  });

  test("falls back to the prompt when the row exists but no turn landed", async () => {
    const store = new FakeStore();
    const existingId = store.seedChild("parent-1", "call-1", []);

    const { sessionId, turns } = await resolveSubagentSession(asStore(store), {
      parentSessionId: "parent-1",
      toolCallId: "call-1",
      description: taskLabel,
      prompt: "Find the thing.",
    });

    // 进程恰好死在"写了行"和"写了第一轮"之间的场景：喂一个空 transcript
    // 会让子 agent 连自己的任务书都没有。
    expect(sessionId).toBe(existingId);
    expect(turns).toHaveLength(1);
    expect(turns[0] && textOf(turns[0])).toBe("Find the thing.");
  });

  test("tells two calls in the same parent apart", async () => {
    const store = new FakeStore();

    const first = await resolveSubagentSession(asStore(store), {
      parentSessionId: "parent-1",
      toolCallId: "call-1",
      description: taskLabel,
      prompt: "First.",
    });
    const second = await resolveSubagentSession(asStore(store), {
      parentSessionId: "parent-1",
      toolCallId: "call-2",
      description: taskLabel,
      prompt: "Second.",
    });

    expect(first.sessionId).not.toBe(second.sessionId);
    expect(store.saved).toHaveLength(2);
  });
});

describe(selectSubagentTools, () => {
  const tools = {
    bash: {},
    grep: {},
    questionnaire: {},
    task: {},
  } as unknown as Parameters<typeof selectSubagentTools>[0];

  test("always drops task and questionnaire", () => {
    expect(Object.keys(selectSubagentTools(tools, definition))).toStrictEqual([
      "bash",
      "grep",
    ]);
  });

  test("keeps only the definition's allow-list when it has one", () => {
    const narrowed: SubagentDefinition = { ...definition, tools: ["grep"] };
    expect(Object.keys(selectSubagentTools(tools, narrowed))).toStrictEqual([
      "grep",
    ]);
  });

  test("drops task even when the allow-list asks for it", () => {
    const narrowed: SubagentDefinition = { ...definition, tools: ["task"] };
    expect(Object.keys(selectSubagentTools(tools, narrowed))).toStrictEqual([]);
  });
});

describe("subagent 的 abort scope", () => {
  /**
   * 造一个真的父 agent：`context.abortSignal` 由它的构造函数设成自己的
   * controller，这正是 `createSubagent` 要接过去的东西。
   */
  const buildParent = (): Agent =>
    new Agent({
      name: "main",
      sessionId: "parent-session",
      session: new AgentSession({ turns: [] }),
      store: asStore(new FakeStore()),
      context: new AgentContext({
        projectDirs: ["/tmp"],
        sessionDir: "/tmp/sessions/parent-session",
        modelId: "test-model",
        skills: new SkillManager({ dirs: [] }),
        compactionConfig: {
          recentWindowSize: 10,
          threshold: 100_000,
          thresholdPercent: 0.9,
          lastKnownInputTokens: 0,
          lastKnownPromptMessageCount: 0,
        },
      }),
      apiKey: "test-key",
      apiUrl: "http://localhost",
      providerId: "test-provider",
      modelId: "test-model",
    });

  const spawnChild = (parent: Agent) =>
    createSubagent(
      {
        context: parent.context,
        tools: {},
        credentials: {
          apiKey: parent.apiKey,
          apiUrl: parent.apiUrl,
          providerId: parent.providerId,
        },
        sessionId: parent.sessionId,
        toolCallId: "call-1",
      },
      {
        definition,
        prompt: "Find the thing.",
        store: asStore(new FakeStore()),
        description: taskLabel,
      }
    );

  test("父被停时子 agent 跟着停", async () => {
    const parent = buildParent();
    const { agent: child } = await spawnChild(parent);

    expect(child.context.abortSignal?.aborted).toBeFalsy();

    parent.abort();

    // 这是 stop 能立刻返回的前提：子 agent 一停，它的流就结束，父那个 task
    // 调用的 `whenFinished()` 才有东西可等。
    expect(child.context.abortSignal?.aborted).toBeTruthy();
  });

  test("子 agent 自己停不牵连父", async () => {
    const parent = buildParent();
    const { agent: child } = await spawnChild(parent);

    child.abort();

    // 并集而不是替代：子 agent 仍然保有自己的 abort 入口。
    expect(child.context.abortSignal?.aborted).toBeTruthy();
    expect(parent.context.abortSignal?.aborted).toBeFalsy();
  });

  test("父已经停了才派生出来的子 agent 一建出来就是停的", async () => {
    const parent = buildParent();
    parent.abort();

    const { agent: child } = await spawnChild(parent);

    expect(child.context.abortSignal?.aborted).toBeTruthy();
  });
});

describe("subagent 继承项目说明", () => {
  const parentContextFiles: ContextFile[] = [
    { path: "/repo/AGENTS.md", content: "Always run the tests." },
  ];
  const projectSection = {
    id: "project",
    render: (prompt: string): string =>
      `${prompt}\n\n${renderProjectContext(parentContextFiles)}`,
  };

  const buildParent = (): Agent =>
    new Agent({
      name: "main",
      sessionId: "parent-session",
      session: new AgentSession({ turns: [] }),
      store: asStore(new FakeStore()),
      context: new AgentContext({
        projectDirs: ["/tmp"],
        sessionDir: "/tmp/sessions/parent-session",
        modelId: "test-model",
        skills: new SkillManager({ dirs: [] }),
        systemPromptSections: [projectSection],
        compactionConfig: {
          recentWindowSize: 10,
          threshold: 100_000,
          thresholdPercent: 0.9,
          lastKnownInputTokens: 0,
          lastKnownPromptMessageCount: 0,
        },
      }),
      apiKey: "test-key",
      apiUrl: "http://localhost",
      providerId: "test-provider",
      modelId: "test-model",
    });

  test("子 agent 拿到父加载的那份文件，并且写进了 system prompt", async () => {
    const parent = buildParent();
    const { agent: child } = await createSubagent(
      {
        context: parent.context,
        tools: {},
        credentials: {
          apiKey: parent.apiKey,
          apiUrl: parent.apiUrl,
          providerId: parent.providerId,
        },
        sessionId: parent.sessionId,
        toolCallId: "call-1",
      },
      {
        definition,
        prompt: "Find the thing.",
        store: asStore(new FakeStore()),
        description: taskLabel,
      }
    );

    expect(child.context.systemPromptSections).toStrictEqual([projectSection]);
    expect(child.systemPrompt).toContain(
      '<project_instructions path="/repo/AGENTS.md">'
    );
    expect(child.systemPrompt).toContain("Always run the tests.");
    expect(child.systemPrompt).toContain(definition.instructions);
  });
});

describe(readSubagentResult, () => {
  test("reports the last thing the subagent said", () => {
    expect(
      readSubagentResult([buildPromptTurn("Go."), assistantTurn("Done.")])
    ).toStrictEqual({ report: "Done.", status: "done" });
  });

  test("carries the turn's own ending, not a flattened one", () => {
    expect(
      readSubagentResult([assistantTurn("Broke.", "error")])
    ).toStrictEqual({
      report: "Broke.",
      status: "error",
    });
  });

  test("reports an error when there is no assistant turn to read", () => {
    expect(readSubagentResult([buildPromptTurn("Go.")])).toStrictEqual({
      report: "",
      status: "error",
    });
  });
});
