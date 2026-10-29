import type { ToolSet } from "ai";
import { describe, expect, test } from "vitest";

import { AgentTurnAssembler } from "../src/agent-turn-assembler.js";
import type { AssemblerModule } from "../src/agent-turn-assembler.js";

const startTurn = {
  type: "turn.start",
  id: "turn-1",
  turnType: "assistant",
  createdAt: 1,
} as const;

const startStep = {
  type: "step.start",
  id: "step-1",
  turnId: "turn-1",
  stepType: "assistant",
  model: "test-model",
  createdAt: 2,
} as const;

describe("AgentTurnAssembler#registerAssembler", () => {
  test("runs a registered module's settle hook", () => {
    const assembler = new AgentTurnAssembler<ToolSet>({ turns: [] });
    const outcomes: string[] = [];

    assembler.registerAssembler({
      name: "probe",
      events: {},
      settle: (outcome) => {
        outcomes.push(outcome);
      },
    });

    assembler.settle("aborted");

    expect(outcomes).toStrictEqual(["aborted"]);
  });

  test("stops running the hook after the module is disposed", () => {
    const assembler = new AgentTurnAssembler<ToolSet>({ turns: [] });
    const outcomes: string[] = [];

    const dispose = assembler.registerAssembler({
      name: "probe",
      events: {},
      settle: (outcome) => {
        outcomes.push(outcome);
      },
    });

    dispose();
    assembler.settle("error");

    expect(outcomes).toStrictEqual([]);
  });

  test("rejects a module name that is already taken", () => {
    const assembler = new AgentTurnAssembler<ToolSet>({ turns: [] });
    const module: AssemblerModule<ToolSet> = { name: "probe", events: {} };

    assembler.registerAssembler(module);

    expect(() => assembler.registerAssembler(module)).toThrow(
      /module "probe" is already registered/u
    );
  });

  test("rejects a claim on an event the core modules already handle", () => {
    const assembler = new AgentTurnAssembler<ToolSet>({ turns: [] });

    expect(() =>
      assembler.registerAssembler({
        name: "late",
        events: { "text.delta": () => {} },
      })
    ).toThrow(/event "text.delta" is already handled by module "text"/u);
  });

  test("rejects two modules that claim the same event", () => {
    const assembler = new AgentTurnAssembler<ToolSet>({ turns: [] });

    assembler.registerAssembler(
      { name: "first", events: { "text.delta": () => {} } },
      { replace: true }
    );

    expect(() =>
      assembler.registerAssembler({
        name: "second",
        events: { "text.delta": () => {} },
      })
    ).toThrow(/event "text.delta" is already handled by module "first"/u);
  });

  test("lets a module replace a core handler with an explicit opt-in", async () => {
    const assembler = new AgentTurnAssembler<ToolSet>({ turns: [] });
    const seen: string[] = [];

    assembler.registerAssembler(
      {
        name: "spy",
        events: {
          "text.delta": (_ctx, event) => {
            seen.push(event.text);
          },
        },
      },
      { replace: true }
    );

    await assembler.push(startTurn);
    await assembler.push({
      type: "step.start",
      id: "step-1",
      turnId: "turn-1",
      stepType: "assistant",
      model: "test-model",
      createdAt: 2,
    });
    await assembler.push({
      type: "text.start",
      id: "text-1",
      turnId: "turn-1",
      stepId: "step-1",
      createdAt: 3,
    });
    await assembler.push({
      type: "text.delta",
      id: "text-1",
      turnId: "turn-1",
      stepId: "step-1",
      text: "hi",
      createdAt: 4,
    });

    expect(seen).toStrictEqual(["hi"]);
    // 只有 delta 被替换，start 仍然由内置模块建立 part。
    expect(assembler.turns[0]?.content[0]?.content).toHaveLength(1);
  });
});

const customEvent = (kind: `${string}.${string}`) =>
  ({
    type: "custom",
    kind,
    turnId: "turn-1",
    stepId: "step-1",
    createdAt: 3,
  }) as const;

const stepContent = (assembler: AgentTurnAssembler<ToolSet>) =>
  assembler.turns[0]?.content[0]?.content;

describe("AgentTurnAssembler custom kind routing", () => {
  test("routes a claimed kind to its module instead of the opaque part", async () => {
    const assembler = new AgentTurnAssembler<ToolSet>({ turns: [] });
    const seen: string[] = [];

    assembler.registerAssembler({
      name: "plan",
      events: {
        "custom:plan.updated": (_ctx, event) => {
          seen.push(event.kind);
        },
      },
    });

    await assembler.push(startTurn);
    await assembler.push(startStep);
    await assembler.push(customEvent("plan.updated"));

    expect(seen).toStrictEqual(["plan.updated"]);
    expect(stepContent(assembler)).toHaveLength(0);
  });

  test("keeps an unclaimed kind as an opaque custom part", async () => {
    const assembler = new AgentTurnAssembler<ToolSet>({ turns: [] });

    await assembler.push(startTurn);
    await assembler.push(startStep);
    await assembler.push(customEvent("other.thing"));

    expect(stepContent(assembler)).toStrictEqual([
      {
        type: "custom",
        kind: "other.thing",
        providerMetadata: undefined,
      },
    ]);
  });

  test("rejects two modules that claim the same kind", () => {
    const assembler = new AgentTurnAssembler<ToolSet>({ turns: [] });

    assembler.registerAssembler({
      name: "first",
      events: { "custom:plan.updated": () => {} },
    });

    expect(() =>
      assembler.registerAssembler({
        name: "second",
        events: { "custom:plan.updated": () => {} },
      })
    ).toThrow(
      /event "custom:plan.updated" is already handled by module "first"/u
    );
  });
});
