import { tool } from "ai";
import type { Tool } from "ai";
import { describe, expect, test } from "vitest";
import { z } from "zod";

import { createSessionAgent } from "../src/agent-factory.js";
import { AgentSession } from "../src/agent-session.js";
import { resolvePolicy } from "../src/compaction/policy.js";
import { Capabilities } from "../src/extensions/capabilities.js";
import type { ExtensionAPI } from "../src/extensions/types.js";
import { Extension } from "../src/extensions/types.js";
import type { ToolCallHookEvent } from "../src/hooks-manager.js";
import type { CompactionStrategy } from "../src/kernel/compaction-strategy.js";
import type { AgentStore } from "../src/storage/index.js";
import type { TimerStore } from "../src/timers/types.js";
import { evaluateToolApproval } from "../src/tool-approval.js";
import { catalogEntries } from "../src/tool-catalog/catalog.js";
import { testModel, testResolveModel } from "./helpers/model-target.js";
import { testSandbox } from "./helpers/sandbox.js";

const makeAgent = (
  options: Partial<Parameters<typeof createSessionAgent>[0]> = {}
) =>
  createSessionAgent({
    sessionId: "session-1",
    store: {} as AgentStore,
    session: new AgentSession({ turns: [] }),
    model: { ref: testModel() },
    resolveModel: testResolveModel,
    projectDirs: ["/tmp"],
    sessionDir: "/tmp/session-1",
    sandbox: testSandbox("/tmp", "/tmp/session-1"),
    ...options,
  });

const markerTool = (): Tool =>
  tool({
    description: "Marks the host extension.",
    inputSchema: z.object({}),
    execute: () => ({ ok: true }),
  });

/** 一个没有内容的定时器存储面：这里只关心工具是否注册。 */
const idleTimerStore = (): TimerStore => ({
  insertTimer: () => Promise.reject(new Error("not used")),
  listTimers: () => Promise.resolve([]),
  cancelTimer: () => Promise.resolve(false),
  fireDueTimers: () => Promise.resolve([]),
  timerCounts: () => Promise.resolve({ pending: 0, pendingSchedules: 0 }),
});

/** 一个只注册工具的宿主扩展。 */
class HostExtension extends Extension {
  init(api: ExtensionAPI): void {
    api.tool("host-tool", markerTool());
  }
}

/** 一个常驻工具加一个只进目录的宿主扩展。 */
class DeferredExtension extends Extension {
  init(api: ExtensionAPI): void {
    api.tool("resident-tool", markerTool());
    api.tool("hidden-tool", markerTool(), { exposure: "deferred" });
  }
}

const approvalRequest = (
  toolName: string,
  input: unknown = {}
): ToolCallHookEvent => ({
  sessionId: "session-1",
  turnId: "turn-1",
  stepId: "step-1",
  toolCallId: "call-1",
  toolName,
  input,
  messages: [],
});

const decide = async (
  agent: Awaited<ReturnType<typeof createSessionAgent>>,
  toolName: string,
  input: unknown = {}
) =>
  await evaluateToolApproval(
    agent.toolApprovalPattern,
    approvalRequest(toolName, input)
  );

describe("the approval notice in the prompt", () => {
  test("a read-only session tells the model what it refuses", async () => {
    const agent = await makeAgent({ approvalPolicy: "readonly" });
    let rendered = "";
    for (const section of agent.context.instructionsSections) {
      rendered = section.render(rendered);
    }

    expect(rendered).toContain(
      "This session refuses writes to disk and shell commands"
    );
  });
});

describe(createSessionAgent, () => {
  test("registers the default tool extensions", async () => {
    const agent = await makeAgent();

    expect(Object.keys(agent.tools)).toStrictEqual(
      expect.arrayContaining([
        "read-file",
        "write-file",
        "web-fetch",
        "task",
        "questionnaire",
      ])
    );

    // 默认档放行改动；问卷仍然要问，那是组合根唯一保留的一问。
    await expect(decide(agent, "write-file")).resolves.toStrictEqual({
      decision: "allow",
    });
    await expect(decide(agent, "delete-file")).resolves.toStrictEqual({
      decision: "allow",
    });
    await expect(decide(agent, "questionnaire")).resolves.toStrictEqual({
      decision: "ask",
    });
    await expect(decide(agent, "read-file")).resolves.toBeUndefined();
  });

  test("registers the timer tools only when the session has timers", async () => {
    const without = await makeAgent();
    expect(Object.keys(without.tools)).not.toContain("timer-set");

    const withTimers = await makeAgent({ timers: idleTimerStore() });

    expect(Object.keys(withTimers.tools)).toStrictEqual(
      expect.arrayContaining(["timer-set", "timer-list", "timer-cancel"])
    );
  });

  test("registers host rules for its own tools", async () => {
    const agent = await makeAgent({
      toolApprovalPattern: ({ toolName }) =>
        toolName === "host-tool" ? { decision: "deny" } : undefined,
    });

    await expect(decide(agent, "host-tool")).resolves.toStrictEqual({
      decision: "deny",
    });
    await expect(decide(agent, "read-file")).resolves.toBeUndefined();
  });

  test("adds host extensions after the defaults", async () => {
    const agent = await makeAgent({
      extensions: [new HostExtension({ id: "host" })],
    });

    expect(agent.tools["host-tool"]).toBeDefined();
  });

  test("keeps a deferred tool registered but out of the declared set", async () => {
    const agent = await makeAgent({
      extensions: [new DeferredExtension({ id: "host" })],
    });

    // 注册照旧：转调要按名字找到它。
    expect(agent.tools["hidden-tool"]).toBeDefined();
    expect(agent.toolExposure.get("hidden-tool")).toBe("deferred");
    // 目录读的是同一份注册信息，所以宿主扩展后注册的工具也在里面。
    expect(
      catalogEntries(agent.tools, agent.toolExposure).map((entry) => entry.name)
    ).toStrictEqual(["hidden-tool"]);
  });

  test("registers the two catalog tools and the paragraph that points at them", async () => {
    const agent = await makeAgent();

    // 两个常驻工具由目录扩展自己注册。
    expect(agent.tools["search-tools"]).toBeDefined();
    expect(agent.tools["call-tool"]).toBeDefined();
    // 没有目录条目时这个片段什么都不加；别的片段照常写自己的段落。
    expect(agent.extensions.renderInstructions("base")).not.toContain(
      "## Tool catalog"
    );
  });

  test("names the server in the paragraph once it has hidden tools", async () => {
    const agent = await makeAgent({
      extensions: [new DeferredExtension({ id: "host" })],
    });

    expect(agent.extensions.renderInstructions("base")).toContain(
      "## Tool catalog"
    );
  });

  test("provides the default compaction strategy", async () => {
    const agent = await makeAgent();
    const strategy = agent.extensions.capability(Capabilities.compaction);

    expect(strategy).toBeDefined();
    // 窗口来自上下文：没有配置窗口时自动压缩关闭，而不是猜一个阈值。
    expect(strategy?.policy().thresholdTokens).toBeUndefined();
    expect(
      strategy?.policy({ contextWindow: 100_000 }).thresholdTokens
    ).toBeGreaterThan(0);
  });

  test("lets a host extension replace the compaction strategy", async () => {
    const custom: CompactionStrategy = {
      policy: () => resolvePolicy({ overrides: { auto: false } }),
      summarize: () => {
        throw new Error("not used");
      },
    };

    class CompactExtension extends Extension {
      init(api: ExtensionAPI): void {
        api.provide(Capabilities.compaction, custom, { override: true });
      }
    }

    const agent = await makeAgent({
      extensions: [new CompactExtension({ id: "host-compaction" })],
    });

    expect(agent.extensions.capability(Capabilities.compaction)).toBe(custom);
  });

  test("releases the extensions when setup fails", async () => {
    let disposed = false;

    class GoodExtension extends Extension {
      dispose(): void {
        disposed = true;
      }
    }

    class BrokenExtension extends Extension {
      init(): void {
        throw new Error("boom");
      }
    }

    await expect(
      makeAgent({
        extensions: [
          new GoodExtension({ id: "good" }),
          new BrokenExtension({ id: "broken" }),
        ],
      })
    ).rejects.toThrow("boom");

    // 已经注册的扩展在装配失败时也要收掉，半成品 agent 不留在内存里。
    expect(disposed).toBeTruthy();
  });
});

describe("approval policy", () => {
  test("edit approves a mutation and still asks the interview", async () => {
    const agent = await makeAgent({ approvalPolicy: "edit" });

    await expect(decide(agent, "write-file")).resolves.toStrictEqual({
      decision: "allow",
    });
    await expect(decide(agent, "questionnaire")).resolves.toStrictEqual({
      decision: "ask",
    });
    await expect(decide(agent, "read-file")).resolves.toBeUndefined();
  });

  test("read-only denies a mutation and a command", async () => {
    const agent = await makeAgent({ approvalPolicy: "readonly" });

    await expect(decide(agent, "write-file")).resolves.toStrictEqual({
      decision: "deny",
      reason: "This session's approval policy refuses writes to disk.",
    });
    await expect(decide(agent, "bash")).resolves.toStrictEqual({
      decision: "deny",
      reason: "This session's approval policy refuses shell commands.",
    });
    await expect(decide(agent, "read-file")).resolves.toBeUndefined();
  });

  test("unrestricted relaxes the host's ask but not its denial", async () => {
    const agent = await makeAgent({
      approvalPolicy: "unrestricted",
      toolApprovalPattern: ({ toolName }) => {
        if (toolName === "host-ask") {
          return { decision: "ask" };
        }

        return toolName === "host-deny"
          ? { decision: "deny", reason: "blocked" }
          : undefined;
      },
    });

    await expect(decide(agent, "host-ask")).resolves.toStrictEqual({
      decision: "allow",
    });
    await expect(decide(agent, "host-deny")).resolves.toStrictEqual({
      decision: "deny",
      reason: "blocked",
    });
  });

  test("spawning a subagent is not an interview", async () => {
    const agent = await makeAgent();

    await expect(decide(agent, "task")).resolves.toBeUndefined();
  });

  test("unrestricted closes the host's ask for a destructive tool", async () => {
    const destructive = "mcp__linear__delete_issue";
    const agent = await makeAgent({
      approvalPolicy: "unrestricted",
      toolApprovalPattern: ({ toolName }) =>
        toolName === destructive ? { decision: "ask" } : undefined,
      resolveApprovalClass: ({ toolName }) =>
        toolName === destructive ? "mutate" : "unknown",
    });

    // The policy leads where it speaks: "never ask" also covers a tool the
    // server itself calls destructive. A refusal would still stand.
    await expect(decide(agent, destructive)).resolves.toStrictEqual({
      decision: "allow",
    });
  });

  test("a read-only session refuses a call the host allowed", async () => {
    const agent = await makeAgent({
      approvalPolicy: "readonly",
      toolApprovalPattern: ({ toolName }) =>
        toolName === "write-file" ? { decision: "allow" } : undefined,
    });

    await expect(decide(agent, "write-file")).resolves.toStrictEqual({
      decision: "deny",
      reason: "This session's approval policy refuses writes to disk.",
    });
  });
});
