import { describe, expect, test } from "vitest";

import type { AgentContext } from "../../src/agent-context.js";
import { JobRegistry } from "../../src/jobs/registry.js";
import type { JobHandle, JobOutcome } from "../../src/jobs/types.js";
import { createJobTools } from "../../src/tools/jobs.js";

const SESSION = "session-1";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

const deferred = <T>(): Deferred<T> => {
  let settle!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    settle = resolve;
  });
  return { promise, resolve: settle };
};

const createRegistry = (): JobRegistry => new JobRegistry({ warn: () => {} });

const createContext = (jobs: JobRegistry, sessionId = SESSION): AgentContext =>
  ({
    jobs,
    sessionId,
    primaryProjectDir: "/tmp",
    sessionDir: `/tmp/sessions/${sessionId}`,
  }) as unknown as AgentContext;

type StartedJob = {
  jobId: string;
  cancels: (string | undefined)[];
  handle: () => JobHandle;
  settle: (outcome: JobOutcome) => void;
};

/**
 * 一个测试可控的生产方。默认在 cancel 时以 killed 结算，销毁和取消路径都
 * 不会挂住。
 */
const startJob = (
  jobs: JobRegistry,
  options: { owner?: string; label?: string; append?: string } = {}
): StartedJob => {
  const gate = deferred<JobOutcome>();
  const cancels: (string | undefined)[] = [];
  let handle!: JobHandle;
  const jobId = jobs.start({
    kind: "bash",
    label: options.label ?? "sleep 60",
    ...(options.owner === undefined ? {} : { owner: options.owner }),
    run: (job) => {
      handle = job;
      if (options.append !== undefined) {
        job.append(options.append);
      }
      return {
        cancel: (reason) => {
          cancels.push(reason);
          gate.resolve({ status: "killed", detail: reason });
        },
        done: gate.promise,
      };
    },
  });
  return {
    jobId,
    cancels,
    handle: () => handle,
    settle: (outcome) => {
      gate.resolve(outcome);
    },
  };
};

/** 三个工具的真实返回形状：模型侧只有一段文本。 */
type JobToolResult = {
  output: string;
  code: string;
};

const call = async (
  jobTool: {
    execute?: (input: never, options: never) => unknown;
  },
  input: unknown
): Promise<JobToolResult> => {
  const { execute } = jobTool;
  if (execute === undefined) {
    throw new TypeError("job tool has no execute function");
  }
  return (await execute(
    input as never,
    {
      toolCallId: "call-1",
      messages: [],
    } as never
  )) as JobToolResult;
};

describe("job-output", () => {
  test("returns the unread delta and the status line", async () => {
    const jobs = createRegistry();
    const tools = createJobTools({ agentContext: createContext(jobs) });
    const job = startJob(jobs, { append: "hello\n" });

    const first = await call(tools["job-output"], { jobId: job.jobId });

    const second = await call(tools["job-output"], { jobId: job.jobId });

    expect(first.output).toBe("hello\n[status: running]");
    expect(second.output).toBe("(no new output)\n[status: running]");
  });

  test("hands over the producer's result once after settlement", async () => {
    const jobs = createRegistry();
    const tools = createJobTools({ agentContext: createContext(jobs) });
    const job = startJob(jobs, { append: "out\n" });

    job.settle({ status: "completed", result: "final answer" });
    await jobs.wait(job.jobId, 1000);

    const first = await call(tools["job-output"], { jobId: job.jobId });
    const second = await call(tools["job-output"], { jobId: job.jobId });

    expect(first.output).toBe("out\nfinal answer\n[status: completed]");
    expect(second.output).toBe("(no new output)\n[status: completed]");
  });

  test("wait blocks until the job settles", async () => {
    const jobs = createRegistry();
    const tools = createJobTools({ agentContext: createContext(jobs) });
    const job = startJob(jobs);
    setTimeout(() => {
      job.settle({ status: "completed", result: "late result" });
    }, 10);

    const result = await call(tools["job-output"], {
      jobId: job.jobId,
      wait: true,
      timeoutMs: 1000,
    });

    expect(result.output).toContain("late result");
    expect(result.output).toContain("[status: completed]");
  });

  test("a timed-out wait reports the running job without killing it", async () => {
    const jobs = createRegistry();
    const tools = createJobTools({ agentContext: createContext(jobs) });
    const job = startJob(jobs);

    const result = await call(tools["job-output"], {
      jobId: job.jobId,
      wait: true,
      timeoutMs: 20,
    });

    expect(result.output).toBe("(no new output)\n[status: running]");
    expect(job.cancels).toStrictEqual([]);
  });

  test("refuses an unknown job and another session's job", async () => {
    const jobs = createRegistry();
    const tools = createJobTools({ agentContext: createContext(jobs) });
    const foreign = startJob(jobs, { owner: "session-2" });

    await expect(
      call(tools["job-output"], { jobId: "bash-missing" })
    ).rejects.toThrow("unknown job");
    await expect(
      call(tools["job-output"], { jobId: foreign.jobId })
    ).rejects.toThrow("belongs to another session");
  });
});

describe("job-list", () => {
  test("lists only the caller's jobs, one line each", async () => {
    const jobs = createRegistry();
    const tools = createJobTools({ agentContext: createContext(jobs) });
    const owned = startJob(jobs, { owner: SESSION, label: "sleep 60" });
    startJob(jobs, { owner: "session-2", label: "other work" });

    const result = await call(tools["job-list"], {});

    expect(result.output).toBe(`${owned.jobId} [bash] running — sleep 60`);
  });

  test("says so when there is nothing to list", async () => {
    const jobs = createRegistry();
    const tools = createJobTools({ agentContext: createContext(jobs) });

    const result = await call(tools["job-list"], {});

    expect(result.output).toBe("(no background jobs)");
  });
});

describe("job-kill", () => {
  test("requests cancellation and then reports the finished job", async () => {
    const jobs = createRegistry();
    const tools = createJobTools({ agentContext: createContext(jobs) });
    const job = startJob(jobs);

    const requested = await call(tools["job-kill"], {
      jobId: job.jobId,
      reason: "no longer needed",
    });

    expect(requested.output).toBe(`requested cancellation of job ${job.jobId}`);
    expect(job.cancels).toStrictEqual(["no longer needed"]);

    await jobs.wait(job.jobId, 1000);

    const again = await call(tools["job-kill"], { jobId: job.jobId });

    expect(again.output).toContain("had already finished");
    expect(again.output).toContain("[status: killed");
  });
});

describe(createJobTools, () => {
  test("refuses to build without a registry", () => {
    const context = {
      sessionId: SESSION,
      primaryProjectDir: "/tmp",
      sessionDir: "/tmp/sessions/session-1",
    } as unknown as AgentContext;

    expect(() => createJobTools({ agentContext: context })).toThrow(
      "agentContext.jobs"
    );
  });
});
