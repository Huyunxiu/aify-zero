import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import type { AgentContext } from "../../src/agent-context.js";
import { createBashTool } from "../../src/tools/bash.js";
import type {
  ShellForegroundMetadata,
  ShellToolOutput,
} from "../../src/tools/shell/tool.js";

const IS_WINDOWS = process.platform === "win32";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "aify-shell-bash-"));
  tempDirs.push(dir);
  return dir;
}

type ShellTool = ReturnType<typeof createBashTool>;

/** 前台结果的元数据；这些用例都不会产生后台结果。 */
const metadataOf = (output: ShellToolOutput): ShellForegroundMetadata => {
  if (output.metadata?.kind !== "foreground") {
    throw new Error("expected a foreground shell result");
  }
  return output.metadata;
};

function createTool(sessionDir: string): ShellTool {
  const agentContext = {
    primaryProjectDir: sessionDir,
    sessionDir,
  } as unknown as AgentContext;
  return createBashTool({ agentContext });
}

async function call(
  shellTool: ShellTool,
  input: {
    command: string;
    description?: string;
    timeout?: number;
    workdir?: string;
  },
  options: { signal?: AbortSignal } = {}
): Promise<ShellToolOutput> {
  const { execute } = shellTool;
  if (execute === undefined) {
    throw new TypeError("bash tool has no execute function");
  }
  return (await execute(
    {
      description: "Test command",
      ...input,
    },
    {
      toolCallId: "call-1",
      messages: [],
      ...(options.signal === undefined ? {} : { abortSignal: options.signal }),
    } as never
  )) as ShellToolOutput;
}

function modelText(shellTool: ShellTool, output: ShellToolOutput): string {
  const { toModelOutput } = shellTool;
  if (toModelOutput === undefined) {
    throw new TypeError("bash tool has no toModelOutput function");
  }
  const projected = toModelOutput({
    input: { command: "x", description: "x" },
    output,
    toolCallId: "call-1",
  } as never) as { type: string; value?: string };
  return projected.value ?? "";
}

describe("bash tool", () => {
  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
    );
  });

  test(
    "should run in the requested working directory",
    { skip: IS_WINDOWS },
    async () => {
      const dir = await createTempDir();
      await writeFile(join(dir, "marker.txt"), "from the workdir\n");
      const shellTool = createTool(dir);

      const output = await call(shellTool, {
        command: "cat marker.txt",
        workdir: dir,
      });

      expect(output.code).toBe("ok");
      expect(output.output).toBe("from the workdir\n");
      expect(metadataOf(output).exitCode).toBe(0);
      expect(metadataOf(output).timeoutMs).toBe(120_000);
    }
  );

  test(
    "should report a non-zero exit as a model-visible marker",
    { skip: IS_WINDOWS },
    async () => {
      const dir = await createTempDir();
      const shellTool = createTool(dir);

      const output = await call(shellTool, { command: "exit 3" });

      expect(output.code).toBe("ok");
      expect(metadataOf(output).exitCode).toBe(3);
      expect(modelText(shellTool, output)).toContain("[exit code: 3]");
    }
  );

  test(
    "should keep stderr in its own section",
    { skip: IS_WINDOWS },
    async () => {
      const dir = await createTempDir();
      const shellTool = createTool(dir);

      const output = await call(shellTool, { command: "printf err >&2" });

      expect(output.output).toBe("[stderr]\nerr");
    }
  );

  test(
    "should keep the tail and spill the full output",
    { skip: IS_WINDOWS },
    async () => {
      const dir = await createTempDir();
      const shellTool = createTool(dir);

      const output = await call(shellTool, {
        command: "head -c 60000 /dev/zero | tr '\\0' 'a'",
      });

      expect(metadataOf(output).truncated).toBeTruthy();
      expect(output.output).toContain("[output truncated; full output:");
      expect(metadataOf(output).spillPath).toBeDefined();
      const { spillPath } = metadataOf(output);
      if (spillPath === undefined) {
        throw new Error("expected the truncated output to spill to a file");
      }
      const spilled = await readFile(spillPath, "utf-8");
      expect(spilled).toHaveLength(60_000);
    }
  );

  test(
    "should report a timeout in metadata and to the model",
    { skip: IS_WINDOWS },
    async () => {
      const dir = await createTempDir();
      const shellTool = createTool(dir);

      const output = await call(shellTool, {
        command: "sleep 5",
        timeout: 100,
      });

      expect(metadataOf(output).timeout).toBeTruthy();
      expect(modelText(shellTool, output)).toContain("[timed out after 100ms]");
    }
  );

  test(
    "should return an aborted result without throwing",
    { skip: IS_WINDOWS },
    async () => {
      const dir = await createTempDir();
      const shellTool = createTool(dir);
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 50);

      const output = await call(
        shellTool,
        { command: "sleep 5", timeout: 5000 },
        { signal: controller.signal }
      );

      expect(metadataOf(output).aborted).toBeTruthy();
      expect(modelText(shellTool, output)).toContain("[aborted]");
    }
  );

  test(
    "should reject before running when the workdir is missing",
    { skip: IS_WINDOWS },
    async () => {
      const dir = await createTempDir();
      const shellTool = createTool(dir);

      await expect(
        call(shellTool, {
          command: "printf hi",
          workdir: join(dir, "missing"),
        })
      ).rejects.toThrow(/Working directory does not exist/u);
    }
  );
});
