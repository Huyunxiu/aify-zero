import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, test } from "vitest";

import { FileToolsExtension } from "../../src/extensions/builtin/file-tools.js";
import type { ModelTargetResolver } from "../../src/kernel/model-gateway.js";
import { FakeStore, makeAgent, runTurn } from "../helpers/turn-agent.js";
import { startProvider, useStartedProviders } from "../testing/helpers.js";

/**
 * The image reaches the model on the wire, not only in the messages we assemble.
 *
 * `read-file` answers with a tool result that carries a file part. The chat protocol keeps
 * a tool message to text, so the provider adapter serializes that part itself unless the
 * model config opts in, and the model reads base64. This case drives a real Agent through
 * a real HTTP request and reads the body the provider was given, so a change to the
 * adapter's default fails here.
 *
 * The image is `tests/fixtures/half-red-half-blue.png`: red on the left, blue on the
 * right. Nothing here asserts the colour; it is what a reader sees when they open it.
 */
const FIXTURE = new URL("../fixtures/half-red-half-blue.png", import.meta.url);

/** One wire message, as the chat protocol spells it. */
type WireMessage = {
  readonly role: string;
  readonly content?: unknown;
};

const scenario = {
  name: "read-image-then-answer",
  models: ["test-model"],
  rules: [
    // A title request is non-streaming where the runner makes one. It must not consume
    // the rule that asks for the read, or the turn would answer instead of reading.
    { when: { stream: false }, answer: "Read the image" },
    {
      when: { stream: true },
      toolCall: {
        id: "call-read-1",
        name: "read-file",
        args: { path: "shot.png" },
      },
    },
    { when: { stream: true }, answer: "Red on the left, blue on the right." },
  ],
};

const dirs: string[] = [];

const makeDirs = (): { projectDir: string; sessionDir: string } => {
  const projectDir = mkdtempSync(join(tmpdir(), "wire-project-"));
  const sessionDir = mkdtempSync(join(tmpdir(), "wire-session-"));
  writeFileSync(join(projectDir, "shot.png"), readFileSync(FIXTURE));
  dirs.push(projectDir, sessionDir);
  return { projectDir, sessionDir };
};

const messagesOf = (body: unknown): WireMessage[] => {
  const { messages } = body as { messages?: WireMessage[] };
  if (messages === undefined) {
    throw new Error("the request body should carry messages");
  }
  return messages;
};

/** The messages of the request that follows the `read-file` call. */
const messagesAfterTheRead = async (): Promise<{
  messages: WireMessage[];
  toolIndex: number;
}> => {
  const provider = await startProvider({ scenario });
  const { projectDir, sessionDir } = makeDirs();
  const resolveModel: ModelTargetResolver = (ref) => ({
    ref,
    name: "Fake",
    protocol: "openai-chat",
    baseURL: provider.baseURL,
    apiKey: "sk-test",
    inputKinds: ["text", "image"],
  });
  const { agent } = makeAgent(new FakeStore(), {
    projectDir,
    sessionDir,
    resolveModel,
  });
  await agent.registerExtension(new FileToolsExtension());

  await runTurn(agent, "What is in shot.png?");

  const streams = provider.requests.filter((request) => request.stream);
  if (streams.length !== 2) {
    throw new Error(
      `the run should make two requests, it made ${streams.length}`
    );
  }
  const messages = messagesOf(streams[1]?.body);
  const toolIndex = messages.findIndex((message) => message.role === "tool");
  if (toolIndex === -1) {
    throw new Error("the second request should carry the tool result");
  }
  return { messages, toolIndex };
};

describe("tool result image on the wire", () => {
  useStartedProviders();

  afterAll(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("should keep the file out of the tool result", async () => {
    const { messages, toolIndex } = await messagesAfterTheRead();

    expect(messages[toolIndex]?.content).toBeTypeOf("string");
    const content = String(messages[toolIndex]?.content);
    expect(content).toContain("shot.png");
    // A file part here is the defect: the chat protocol stringifies the whole content
    // array, so the bytes reach the model as a JSON map of numbers, not as an image.
    expect(content).not.toContain('"type":"file"');
  });

  test("should send the image as a user message after the tool result", async () => {
    const { messages, toolIndex } = await messagesAfterTheRead();

    const after = messages[toolIndex + 1];
    expect(after?.role).toBe("user");
    expect(after?.content).toMatchObject([
      { type: "text", text: expect.stringContaining("call-read-1") as string },
      {
        type: "image_url",
        // The bytes, not a promise of them: PNG on this branch, WebP once a read stores
        // a normalized copy (ADR 0037), and both signatures start the payload.
        image_url: {
          url: expect.stringMatching(
            /^data:image\/(?:png|webp);base64,(?:iVBORw0KGgo|UklGR)/
          ) as string,
        },
      },
    ]);
  });
});
