import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { createHostSandbox } from "@workspace/sandbox";
import type { Sandbox } from "@workspace/sandbox";
import { RIPGREP_PATH_ENV } from "@workspace/shared/constants";
import { afterEach, describe, expect, test, vi } from "vitest";

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

const pathWithoutRipgrep = (): string => {
  const binaryName = process.platform === "win32" ? "rg.exe" : "rg";
  return (process.env.PATH ?? "")
    .split(delimiter)
    .filter(
      (directory) =>
        directory.length > 0 && !existsSync(join(directory, binaryName))
    )
    .join(delimiter);
};

describe("search with workspace ripgrep", () => {
  const originalArgv = [...process.argv];
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    vi.unstubAllEnvs();
    process.argv = [...originalArgv];
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((directory) => rm(directory, { force: true, recursive: true }))
    );
  });

  test("grep and glob work via workspace @vscode/ripgrep without rg on PATH", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aify-search-"));
    temporaryDirectories.push(directory);
    await writeFile(join(directory, "sample.txt"), "hello workspace ripgrep\n");

    vi.stubEnv(RIPGREP_PATH_ENV, "");
    vi.stubEnv("PATH", pathWithoutRipgrep());
    process.argv = [
      originalArgv[0] ?? "node",
      join(tmpdir(), "aify-no-ripgrep-here", "index.js"),
    ];

    vi.resetModules();
    const { createGlobTool: loadGlobTool } =
      await import("../../src/tools/glob.js");
    const { createGrepTool: loadGrepTool } =
      await import("../../src/tools/grep.js");

    const sandbox = createHostSandbox({
      id: "search-test",
      projectDirs: [directory],
      sessionDir: directory,
    });
    const context = {
      sessionId: "session-1",
      projectDirs: [directory],
      primaryProjectDir: directory,
      sessionDir: directory,
      sandbox,
    } as ToolEnvironment;

    const grepTool = loadGrepTool({ agentContext: context });
    const grepResult = (await grepTool.execute(
      {
        context: 0,
        ignoreCase: false,
        limit: 10,
        literal: true,
        path: "sample.txt",
        pattern: "workspace ripgrep",
      },
      run
    )) as unknown as SearchResult;

    expect(grepResult.code).toBe("ok");
    expect(grepResult.output).toContain("hello workspace ripgrep");

    const globTool = loadGlobTool({ agentContext: context });
    const globResult = (await globTool.execute(
      {
        limit: 10,
        pattern: "*.txt",
      },
      run
    )) as unknown as SearchResult;

    expect(globResult.code).toBe("ok");
    expect(globResult.output).toContain("sample.txt");
  });
});
