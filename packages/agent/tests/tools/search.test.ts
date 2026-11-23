import type { Sandbox } from "@workspace/sandbox";
import { describe, expect, test } from "vitest";

import type { AgentContext } from "../../src/agent-context.js";
import type { ToolEnvironment } from "../../src/extensions/capabilities.js";
import { createGlobTool } from "../../src/tools/glob.js";
import { createGrepTool } from "../../src/tools/grep.js";

/** A sandbox that records whether a command ran, and refuses to run one. */
const recordingSandbox = (): { sandbox: Sandbox; ran: () => boolean } => {
  let ran = false;

  const sandbox = {
    resolvePath: (path: string) => path,
    exec: () => {
      ran = true;
      throw new Error("a search command ran");
    },
  } as unknown as Sandbox;

  return { sandbox, ran: () => ran };
};

const environment = (sandbox: Sandbox): ToolEnvironment =>
  ({
    sessionId: "session-1",
    projectDirs: ["/repo"],
    primaryProjectDir: "/repo",
    sessionDir: "/repo/.session",
    sandbox,
  }) as ToolEnvironment;

const unavailable = () => Promise.resolve(false);

const run = { toolCallId: "call-1", messages: [], context: {} as AgentContext };

/** What the tool says when it refuses to search. */
type SearchResult = { output: string; code: "ok" | "error" };

describe("search without ripgrep", () => {
  test("glob says why it cannot search, and runs nothing", async () => {
    const { sandbox, ran } = recordingSandbox();
    const tool = createGlobTool({
      agentContext: environment(sandbox),
      ripgrepAvailable: unavailable,
    });

    const result = (await tool.execute(
      { limit: 100, pattern: "*.ts" },
      run
    )) as unknown as SearchResult;

    expect(ran()).toBeFalsy();
    expect(result.code).toBe("error");
    expect(result.output).toContain("Glob needs ripgrep");
  });

  test("grep says why it cannot search, and runs nothing", async () => {
    const { sandbox, ran } = recordingSandbox();
    const tool = createGrepTool({
      agentContext: environment(sandbox),
      ripgrepAvailable: unavailable,
    });

    const result = (await tool.execute(
      {
        context: 0,
        ignoreCase: false,
        limit: 100,
        literal: false,
        pattern: "needle",
      },
      run
    )) as unknown as SearchResult;

    expect(ran()).toBeFalsy();
    expect(result.code).toBe("error");
    expect(result.output).toContain("Grep needs ripgrep");
  });
});
