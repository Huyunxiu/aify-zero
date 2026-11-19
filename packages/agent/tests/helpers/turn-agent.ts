import { AgentContext } from "../../src/agent-context.js";
import { AgentSession } from "../../src/agent-session.js";
import { Agent } from "../../src/agents.js";
import type { AgentStore } from "../../src/storage/index.js";
import { asTurns, userTurn } from "../compaction/fixtures.js";
import { testModel, testResolveModel } from "./model-target.js";
import { testSandbox } from "./sandbox.js";

/**
 * 一次回合测试要用的假存储。
 *
 * 只实现 turn 循环会碰到的写入，并把它们记下来供断言：开了几个回合、落了
 * 哪些 step、回写了哪些 turn。
 */
export class FakeStore {
  readonly begun: unknown[] = [];
  readonly savedSteps: { stepId: string; seq: number; status: string }[] = [];
  readonly updated: { id: string; stepIds: ReadonlySet<string> }[] = [];

  getSessionById(): Promise<{
    id: string;
    title: string;
    metadata: Record<string, never>;
    projectId: null;
    kind: "main";
    activeHeadId: null;
    activeStreamId: null;
    status: "idle";
    forkedFromSessionId: null;
    forkedFromMessageId: null;
    parentSessionId: null;
    parentToolCallId: null;
    createdAt: Date;
    updatedAt: Date;
  }> {
    return Promise.resolve(sessionRow);
  }

  saveTurn(): Promise<number> {
    return Promise.resolve(1);
  }

  listInboxItems(): Promise<never[]> {
    return Promise.resolve([]);
  }

  beginTurn({ turn }: { turn: unknown }): Promise<void> {
    this.begun.push(turn);
    return Promise.resolve();
  }

  saveStep(step: {
    stepId: string;
    seq: number;
    status: string;
  }): Promise<number> {
    this.savedSteps.push(step);
    return Promise.resolve(1);
  }

  updateTurn(
    _sessionId: string,
    id: string,
    _turn: unknown,
    { stepIds }: { stepIds?: ReadonlySet<string> } = {}
  ): Promise<number> {
    this.updated.push({ id, stepIds: stepIds ?? new Set() });
    return Promise.resolve(1);
  }
}

const sessionRow = {
  id: "session-1",
  title: "Test session",
  metadata: {},
  projectId: null,
  kind: "main" as const,
  activeHeadId: null,
  activeStreamId: null,
  status: "idle" as const,
  forkedFromSessionId: null,
  forkedFromMessageId: null,
  parentSessionId: null,
  parentToolCallId: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

export const asStore = (store: FakeStore): AgentStore =>
  store as unknown as AgentStore;

/**
 * 造一个只跑回合循环的 Agent；会话由调用方持有，便于事后检查会话记录。
 *
 * 额外工具用 `agent.registerTool` 加：构造函数只收内置工具集。
 */
export const makeAgent = (
  store: FakeStore,
  options: { session?: AgentSession } = {}
): { agent: Agent; session: AgentSession } => {
  const session = options.session ?? new AgentSession({ turns: [] });
  const agent = new Agent({
    approvalPolicy: "standard",
    name: "main",
    sessionId: "session-1",
    session,
    store: asStore(store),
    tools: {},
    context: new AgentContext({
      sandbox: testSandbox("/tmp", "/tmp/sessions/session-1"),
      sessionId: "session-1",
      projectDirs: ["/tmp"],
      sessionDir: "/tmp/sessions/session-1",
      model: testModel(),
    }),
    model: testModel(),
    resolveModel: testResolveModel,
  });

  return { agent, session };
};

/** 把流读完，只留下事件类型：这个测试关心顺序，不关心负载。 */
export const readAll = async (stream: ReadableStream): Promise<string[]> => {
  const types: string[] = [];
  const reader = stream.getReader();

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    types.push((value as { type: string }).type);
  }

  return types;
};

/** 发一条用户消息，跑完整个回合。 */
export const runTurn = async (agent: Agent, prompt: string) => {
  const finished: string[] = [];
  const stream = await agent.stream({
    turns: asTurns(userTurn("u1", prompt)),
    model: testModel(),
    streamId: "stream-1",
    signal: { type: "turn" },
    onFinish: (status) => {
      finished.push(status);
      return Promise.resolve();
    },
  });

  return { events: await readAll(stream), finished };
};
