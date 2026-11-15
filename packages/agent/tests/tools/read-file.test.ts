import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import type { AgentContext } from "../../src/agent-context";
import { createReadFileTool } from "../../src/tools/read-file";
import { testSandbox } from "../helpers/sandbox.js";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "aify-read-file-"));
  tempDirs.push(dir);
  return dir;
}

function readTool(dir: string) {
  const agentContext = {
    sessionId: "session-1",
    projectDirs: [dir],
    primaryProjectDir: dir,
    sessionDir: dir,
    sandbox: testSandbox(dir),
  } as unknown as AgentContext;

  return createReadFileTool({ agentContext });
}

async function read(dir: string, path: string) {
  const tool = readTool(dir);
  const execute = tool.execute as unknown as (
    input: { path: string },
    options: unknown
  ) => Promise<{ output: string; code: string }>;

  return await execute({ path }, { toolCallId: "call-1", messages: [] });
}

describe("read-file and links", () => {
  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
    );
  });

  test("should report a broken link as a miss, not as a tool failure", async () => {
    const dir = await createTempDir();
    await symlink(join(dir, "gone.txt"), join(dir, "broken.txt"));

    // `stat` 对坏链接会如实回报链接本身（isFile 与 isDirectory 都为 false）。
    // 工具必须把它当成「找不到文件」，而不是接着去读一个读不出来的目标。
    const result = await read(dir, "broken.txt");

    expect(result.code).toBe("error");
    expect(result.output).toContain("File not found");
  });

  test("should follow a link to a file", async () => {
    const dir = await createTempDir();
    await writeFile(join(dir, "real.txt"), "content\n", "utf-8");
    await symlink(join(dir, "real.txt"), join(dir, "link.txt"));

    const result = await read(dir, "link.txt");

    expect(result.code).toBe("ok");
    expect(result.output).toContain("content");
  });
});
