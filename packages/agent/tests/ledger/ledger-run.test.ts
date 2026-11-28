import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  AgentStreamEvent,
  InboxItem,
  LedgerRecord,
} from "@workspace/agent-client";
import type * as AiModule from "ai";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { AgentContext } from "../../src/agent-context.js";
import { AgentSession } from "../../src/agent-session.js";
import { Agent } from "../../src/agents.js";
import type { AgentInbox } from "../../src/inbox/agent-inbox.js";
import { SessionLedgerRecorder } from "../../src/ledger/recorder.js";
import type { AgentStore } from "../../src/storage/index.js";
import type { SessionRecord } from "../../src/storage/types.js";
import type { AgentToolSet } from "../../src/types.js";
import { asTurns, userTurn } from "../compaction/fixtures.js";
import { testModel, testResolveModel } from "../helpers/model-target.js";
import { testSandbox } from "../helpers/sandbox.js";
import {
  script,
  stepResult,
  streamTextMock,
} from "../helpers/stream-harness.js";

// As in the other turn tests: the one model entry is a script, so the loop needs no network.
vi.mock(import("ai"), async (importOriginal) => {
  const actual = await importOriginal<typeof AiModule>();
  return {
    ...actual,
    streamText: vi.fn<
      typeof AiModule.streamText
    >() as unknown as typeof actual.streamText,
  };
});

const sessionRow: SessionRecord = {
  id: "session-1",
  title: "Test session",
  metadata: {},
  botId: "default",
  projectId: null,
  kind: "main",
  activeHeadId: null,
  activeStreamId: null,
  status: "idle",
  forkedFromSessionId: null,
  forkedFromMessageId: null,
  parentSessionId: null,
  parentToolCallId: null,
  approvalPolicy: "edit",
  deletedAt: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

class FakeStore {
  getSessionById(): Promise<SessionRecord> {
    return Promise.resolve(sessionRow);
  }

  saveTurn(): Promise<number> {
    return Promise.resolve(1);
  }

  beginTurn(): Promise<void> {
    return Promise.resolve();
  }

  saveStep(): Promise<number> {
    return Promise.resolve(1);
  }

  updateTurn(): Promise<number> {
    return Promise.resolve(1);
  }
}

class FakeInbox {
  listSteering(): Promise<InboxItem[]> {
    return Promise.resolve([]);
  }

  applySteeringSteps(): Promise<never[]> {
    return Promise.resolve([]);
  }
}

function makeAgent(ledger: SessionLedgerRecorder) {
  const session = new AgentSession({ turns: [] });
  const context = new AgentContext({
    sandbox: testSandbox("/tmp", "/tmp/session-1"),
    sessionId: "session-1",
    model: testModel(),
    projectDirs: ["/tmp"],
    sessionDir: "/tmp/session-1",
  });

  return new Agent({
    approvalPolicy: "edit",
    name: "main",
    sessionId: "session-1",
    session,
    store: new FakeStore() as unknown as AgentStore,
    inbox: new FakeInbox() as unknown as AgentInbox,
    context,
    model: testModel(),
    resolveModel: testResolveModel,
    ledger,
  });
}

async function runTurn(
  agent: Agent
): Promise<AgentStreamEvent<AgentToolSet>[]> {
  const turns = asTurns(userTurn("u1", "把测试跑一遍"));
  const stream = await agent.stream({
    turns,
    model: testModel(),
    streamId: "stream-1",
    signal: { type: "turn" },
    onFinish: () => Promise.resolve(),
  });

  const events: AgentStreamEvent<AgentToolSet>[] = [];
  const reader = stream.getReader();

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    events.push(value);
  }

  return events;
}

function recordsOf(path: string): LedgerRecord[] {
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as LedgerRecord);
}

describe("a run and its ledger", () => {
  beforeEach(() => {
    streamTextMock.mockReset();
  });

  test("records the settings and the content the turn ran under", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ledger-"));
    const ledger = new SessionLedgerRecorder({
      dirOf: () => dir,
      pid: 413,
      appVersion: "0.4.1",
    });

    script(stepResult({ text: "跑完了。" }));
    await runTurn(makeAgent(ledger));

    const records = recordsOf(join(dir, "ledger.jsonl"));
    const settings = records.find(
      (record) => record.type === "note.turn.settings"
    );
    const settled = records.find(
      (record) => record.type === "note.step.settled"
    );

    // The prompt in the ledger must be the prompt the model really read.
    const sent = (
      streamTextMock.mock.calls[0]?.[0] as { instructions?: string } | undefined
    )?.instructions;
    const digest = createHash("sha256")
      .update(sent ?? "")
      .digest("hex");

    expect(settings).toMatchObject({
      type: "note.turn.settings",
      model: testModel(),
      approvalPolicy: "edit",
      instructions: { sha256: digest },
    });
    expect(settled).toMatchObject({ type: "note.step.settled" });

    // Content comes from the settled step: the whole step, so a replay need not read the database.
    const content = records.find(
      (record) => record.type === "note.step.settled"
    );
    expect(
      content?.type === "note.step.settled"
        ? {
            status: content.content.status,
            finishReason: content.content.finishReason,
          }
        : null
    ).toStrictEqual({ status: "done", finishReason: "stop" });

    // This case builds the Agent itself, with no runner channel, so there are notes only.
    expect(
      records.every((record) => record.type.startsWith("note."))
    ).toBeTruthy();
  });
});
