/**
 * One real run, then its ledger read back through the route.
 *
 * This is the seam the other cases cannot reach: the queue, the run, the tool loop, the
 * disk, and the read path in one case. The model side is the fake provider, so the input
 * and the answer are fixed.
 *
 * The assertion stops at the records a person needs: what arrived, what the turn ran under,
 * what settled, and that the run both started and ended. The event payloads belong to the
 * event contract and have their own cases.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { AgentToolSet } from "@workspace/agent";
import type { AgentTurn } from "@workspace/agent-client";
import { startFakeProvider } from "@workspace/agent/testing";
import type { FakeProvider } from "@workspace/agent/testing";
import { beforeAll, describe, expect, test } from "vitest";

import type { AppRouterClient } from "../src/routers/index";

const dir = mkdtempSync(path.join(tmpdir(), "aify-session-ledger-run-"));
process.env.DATABASE_URL = `file:${path.join(dir, "test.db")}`;
process.env.HOME = dir;
process.env.AIFY_SANDBOX_ADAPTER = "host";

const API_TOKEN = "test-api-token";
const MODEL_ID = "fake-fast";
const MODEL = { providerId: "fake", modelId: MODEL_ID };

let client: AppRouterClient;
let fake: FakeProvider;

/** One user turn, the shape the client sends. */
const userTurn = (id: string, text: string): AgentTurn<AgentToolSet> =>
  ({
    id,
    type: "user" as const,
    createdAt: 1,
    status: "done" as const,
    content: [
      {
        id: `${id}-step`,
        type: "user" as const,
        createdAt: 1,
        status: "done" as const,
        content: [{ type: "text", text, createdAt: 1 }],
      },
    ],
  }) as AgentTurn<AgentToolSet>;

describe("a recorded run", () => {
  beforeAll(async () => {
    fake = await startFakeProvider({ scenario: "edit-then-answer" });

    const { migrateDb } = await import("@workspace/db");
    await migrateDb();

    const { createApp } = await import("../src/app");
    const app = createApp({ apiToken: () => API_TOKEN });

    client = createORPCClient(
      new RPCLink({
        url: "http://aify.test/api/rpc",
        headers: { authorization: `Bearer ${API_TOKEN}` },
        fetch: async (request) => await app.request(request),
      })
    );

    // The provider goes in through the real route, so the model is configured the same way
    // a person configures it.
    await client.setting.update({
      providers: [
        {
          id: "fake",
          name: "Fake",
          protocol: "openai-chat",
          baseURL: fake.baseURL,
          apiKey: "sk-test",
          active: true,
          models: [
            {
              id: MODEL_ID,
              name: MODEL_ID,
              active: true,
              modalities: { input: ["text"], output: ["text"] },
            },
          ],
        },
      ],
    });
  });

  test("writes the queue, the settings, the step, and both run boundaries", async () => {
    await client.session.createSession({
      sessionId: "run-1",
      turns: [userTurn("u1", "Say hello.")],
      model: MODEL,
    });

    const records = await waitForLedger("run-1");

    expect(records.map((record) => record.type)).toStrictEqual(
      expect.arrayContaining([
        "note.process",
        "note.inbox.arrived",
        "note.inbox.claimed",
        "stream.run.start",
        "stream.run.event",
        "note.turn.settings",
        "note.step.settled",
        "stream.run.end",
      ])
    );

    // The effective settings and the content: the two things a replay of a fault lacks.
    const settings = records.find(
      (record) => record.type === "note.turn.settings"
    );
    expect(settings).toMatchObject({
      model: MODEL,
      approvalPolicy: "edit",
      instructions: { sha256: expect.any(String) },
    });

    const settled = records.find(
      (record) => record.type === "note.step.settled"
    );
    expect(settled).toMatchObject({ type: "note.step.settled" });

    // The boundaries in order: the start first, the end after.
    const types = records.map((record) => record.type);
    expect(types.indexOf("stream.run.start")).toBeLessThan(
      types.indexOf("stream.run.end")
    );
  }, 60_000);
});

/** Polls the read route until the run's end boundary lands. */
async function waitForLedger(sessionId: string): Promise<{ type: string }[]> {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const read = await client.session.streamSessionLedger({ sessionId });
    if (read.records.some((record) => record.type === "stream.run.end")) {
      return read.records;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 200);
    });
  }
  throw new Error("timed out waiting for the run to end");
}
