import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import type { AgentContext } from "../../src/agent-context.js";
import { createPowerShellTool } from "../../src/tools/powershell.js";
import { resolvePowerShell } from "../../src/tools/shell/resolve.js";
import type { ShellToolOutput } from "../../src/tools/shell/tool.js";

const IS_WINDOWS = process.platform === "win32";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "aify-shell-pwsh-"));
  tempDirs.push(dir);
  return dir;
}

async function call(
  shellTool: ReturnType<typeof createPowerShellTool>,
  command: string,
  workdir: string
): Promise<ShellToolOutput> {
  const { execute } = shellTool;
  if (execute === undefined) {
    throw new TypeError("powershell tool has no execute function");
  }
  return (await execute({ command, description: "Test command", workdir }, {
    toolCallId: "call-1",
    messages: [],
  } as never)) as ShellToolOutput;
}

describe("powershell resolution", () => {
  test("should not resolve outside Windows", () => {
    expect(resolvePowerShell({}, "linux", () => true)).toBeUndefined();
  });

  test("should resolve a Windows PowerShell executable", () => {
    const env = { SystemRoot: "C:\\Windows" };
    const fallback =
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
    expect(resolvePowerShell(env, "win32", (path) => path === fallback)).toBe(
      fallback
    );
  });
});

describe("powershell tool", () => {
  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
    );
  });

  test("should execute with UTF-8 output", { skip: !IS_WINDOWS }, async () => {
    const dir = await createTempDir();
    const agentContext = {
      primaryProjectDir: dir,
      sessionDir: dir,
    } as unknown as AgentContext;
    const shellTool = createPowerShellTool({ agentContext });

    const output = await call(shellTool, "Write-Output 'héllo €'", dir);

    expect(output.code).toBe("ok");
    expect(output.metadata?.exitCode).toBe(0);
    expect(output.output).toContain("héllo €");
  });
});
