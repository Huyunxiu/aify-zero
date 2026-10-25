import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";
import { z } from "zod";

import type { AgentContext } from "../../../src/agent-context.js";
import { JobRegistry } from "../../../src/jobs/registry.js";
import { createBashTool } from "../../../src/tools/bash.js";
import type {
  ShellBackgroundMetadata,
  ShellToolOutput,
} from "../../../src/tools/shell/tool.js";

const IS_WINDOWS = process.platform === "win32";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "aify-shell-background-"));
  tempDirs.push(dir);
  return dir;
}

type ShellTool = ReturnType<typeof createBashTool>;

/**
 * 一个 bash 工具，按需挂上任务注册表。没有注册表时 schema 里就没有
 * `run_in_background`，后台执行也不可用。
 */
function createTool(
  dir: string,
  options: { jobs?: JobRegistry } = {}
): { agentContext: AgentContext; tool: ShellTool } {
  const agentContext = {
    sessionId: "session-1",
    primaryProjectDir: dir,
    sessionDir: dir,
    ...(options.jobs === undefined ? {} : { jobs: options.jobs }),
  } as unknown as AgentContext;
  return { agentContext, tool: createBashTool({ agentContext }) };
}

async function call(
  shellTool: ShellTool,
  input: {
    command: string;
    description?: string;
    timeout?: number;
    workdir?: string;
    run_in_background?: boolean;
  }
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
    } as never
  )) as ShellToolOutput;
}

const backgroundOf = (output: ShellToolOutput): ShellBackgroundMetadata => {
  if (output.metadata?.kind !== "background") {
    throw new Error("expected a background shell result");
  }
  return output.metadata;
};

const schemaKeys = (shellTool: ShellTool): string[] => {
  const { inputSchema } = shellTool;
  if (!(inputSchema instanceof z.ZodObject)) {
    throw new Error("expected an object input schema");
  }
  return Object.keys(inputSchema.shape);
};

describe("bash tool background execution", () => {
  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
    );
  });

  test(
    "starts the command as a job whose output stays readable",
    { skip: IS_WINDOWS },
    async () => {
      const dir = await createTempDir();
      const jobs = new JobRegistry({ warn: () => {} });
      const { tool } = createTool(dir, { jobs });

      const started = await call(tool, {
        command: "printf bg-ok",
        run_in_background: true,
      });
      const { jobId } = backgroundOf(started);

      expect(started.output).toContain(`started background job ${jobId}`);

      const view = await jobs.wait(jobId, 5000, "session-1");
      const read = jobs.read(jobId, "session-1");

      expect(view).toMatchObject({
        status: "completed",
        detail: "exit code: 0",
        owner: "session-1",
        kind: "bash",
      });
      expect(read.chunks.map((chunk) => chunk.text).join("")).toContain(
        "bg-ok"
      );
    }
  );

  test(
    "cancelling the job stops the process",
    { skip: IS_WINDOWS },
    async () => {
      const dir = await createTempDir();
      const jobs = new JobRegistry({ warn: () => {} });
      const { tool } = createTool(dir, { jobs });

      const started = await call(tool, {
        command: "sleep 30",
        run_in_background: true,
      });
      const { jobId } = backgroundOf(started);

      expect(jobs.kill(jobId, "session-1", "stop now")).toBe("requested");

      const view = await jobs.wait(jobId, 5000, "session-1");

      expect(view.status).toBe("killed");
      expect(view.detail).toContain("stop now");
    }
  );

  test("advertises run_in_background only when a registry is composed", async () => {
    const dir = await createTempDir();
    const { tool: withJobs } = createTool(dir, {
      jobs: new JobRegistry({ warn: () => {} }),
    });
    const { tool: withoutJobs } = createTool(dir);

    expect(schemaKeys(withJobs)).toContain("run_in_background");
    expect(schemaKeys(withoutJobs)).not.toContain("run_in_background");
  });

  test(
    "refuses a forced background call without a registry",
    { skip: IS_WINDOWS },
    async () => {
      const dir = await createTempDir();
      const { tool } = createTool(dir);

      await expect(
        call(tool, {
          command: "printf no",
          run_in_background: true,
        })
      ).rejects.toThrow("background execution is unavailable");
    }
  );
});
