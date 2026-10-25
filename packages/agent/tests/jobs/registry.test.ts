import { describe, expect, test } from "vitest";

import { JobRegistry } from "../../src/jobs/registry.js";
import type {
  JobEvent,
  JobHandle,
  JobOutcome,
  JobOutputSource,
  JobSpec,
} from "../../src/jobs/types.js";

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

/** 让出一次宏任务，等注册表内部的结算链路跑完。 */
const flush = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

type Producer = {
  spec: JobSpec;
  handle: JobHandle | undefined;
  cancels: (string | undefined)[];
  settle: (outcome: JobOutcome) => void;
};

/**
 * 一个测试可控的生产方：默认在 cancel 时以 killed 结算，这样销毁路径不会挂住；
 * 需要手动控制结算顺序的用例传 `settleOnCancel: false`。
 */
const producer = (
  overrides: Partial<JobSpec> = {},
  options: { settleOnCancel?: boolean } = {}
): Producer => {
  const gate = deferred<JobOutcome>();
  const cancels: (string | undefined)[] = [];
  const produced: Producer = {
    cancels,
    handle: undefined,
    settle: (outcome) => {
      gate.resolve(outcome);
    },
    spec: {
      kind: "bash",
      label: "sleep 60",
      ...overrides,
      run: (job) => {
        produced.handle = job;
        return {
          cancel: (reason) => {
            cancels.push(reason);
            if (options.settleOnCancel !== false) {
              gate.resolve({ status: "killed", detail: reason });
            }
          },
          done: gate.promise,
        };
      },
    },
  };
  return produced;
};

const createRegistry = (
  options: ConstructorParameters<typeof JobRegistry>[0] = {}
): { registry: JobRegistry; warnings: string[] } => {
  const warnings: string[] = [];
  const registry = new JobRegistry({
    warn: (message) => {
      warnings.push(message);
    },
    ...options,
  });
  return { registry, warnings };
};

/** 订阅全部事件，返回收集器和注销函数。 */
const collectEvents = (
  registry: JobRegistry
): { events: JobEvent[]; dispose: () => void } => {
  const events: JobEvent[] = [];
  const dispose = registry.events.subscribe({ owners: "all" }, (event) => {
    events.push(event);
  });
  return { events, dispose };
};

describe("JobRegistry 身份与准入", () => {
  test("issues a kind-prefixed id with 16 hex characters", () => {
    const { registry } = createRegistry();

    const bash = registry.start(producer().spec);
    const pty = registry.start(producer({ kind: "pty-send" }).spec);

    expect(bash).toMatch(/^bash-[0-9a-f]{16}$/);
    expect(pty).toMatch(/^pty-send-[0-9a-f]{16}$/);
  });

  test("leaves no record and announces nothing when the starter throws", () => {
    const { registry } = createRegistry();
    const { events } = collectEvents(registry);

    expect(() =>
      registry.start({
        kind: "bash",
        label: "boom",
        run: () => {
          throw new Error("boom");
        },
      })
    ).toThrow("boom");

    expect(registry.list()).toStrictEqual([]);
    expect(events).toStrictEqual([]);
  });

  test("rejects an empty kind, label, or owner", () => {
    const { registry } = createRegistry();
    const { spec } = producer();

    expect(() => registry.start({ ...spec, kind: "" })).toThrow(
      "invalid job kind"
    );
    expect(() => registry.start({ ...spec, label: "" })).toThrow(
      "invalid job label"
    );
    expect(() => registry.start({ ...spec, owner: "" })).toThrow(
      "invalid job owner"
    );
  });

  test("refuses a new job at the owner's concurrency limit until one settles", async () => {
    const { registry } = createRegistry({ maxConcurrentJobsPerOwner: 1 });
    const first = producer();
    const firstId = registry.start(first.spec);

    expect(() => registry.start(producer().spec)).toThrow("limit: 1");

    first.settle({ status: "completed" });
    await registry.wait(firstId, 1000);

    expect(() => registry.start(producer().spec)).not.toThrow();
  });

  test("counts each owner separately", () => {
    const { registry } = createRegistry({ maxConcurrentJobsPerOwner: 1 });

    registry.start(producer({ owner: "alice" }).spec);

    expect(() => registry.start(producer({ owner: "bob" }).spec)).not.toThrow();
    expect(() => registry.start(producer({ owner: "alice" }).spec)).toThrow(
      "limit: 1"
    );
  });

  test("rejects invalid configuration at construction", () => {
    expect(() => new JobRegistry({ retainBytes: 0 })).toThrow(
      "invalid retainBytes"
    );
    expect(() => new JobRegistry({ maxConcurrentJobsPerOwner: 1.5 })).toThrow(
      "invalid maxConcurrentJobsPerOwner"
    );
    expect(() => new JobRegistry({ pumpPollMs: Number.NaN })).toThrow(
      "invalid pumpPollMs"
    );
  });
});

describe("JobRegistry 归属围栏", () => {
  test("fences reads, kills, and removals by owner session", () => {
    const { registry } = createRegistry();
    const id = registry.start(producer({ owner: "alice" }).spec);

    expect(() => registry.get(id, "bob")).toThrow("belongs to another session");
    expect(() => registry.get(id)).toThrow("belongs to another session");
    expect(() => registry.kill(id, "bob")).toThrow(
      "belongs to another session"
    );
    expect(() => registry.remove(id, "bob")).toThrow(
      "belongs to another session"
    );
    expect({
      bob: registry.list("bob"),
      alice: registry.list("alice").map((job) => job.id),
    }).toStrictEqual({ bob: [], alice: [id] });
  });

  test("keeps unowned jobs visible to every caller", () => {
    const { registry } = createRegistry();
    const id = registry.start(producer().spec);

    expect(registry.get(id, "bob").id).toBe(id);
    expect(registry.list().map((job) => job.id)).toStrictEqual([id]);
    expect(registry.list("bob").map((job) => job.id)).toStrictEqual([id]);
  });

  test("reports an unknown id", () => {
    const { registry } = createRegistry();

    expect(() => registry.get("bash-missing")).toThrow("unknown job");
  });
});

describe("JobRegistry 生命周期", () => {
  test("kill requests cancellation first, then merges the reason into a killed settlement", async () => {
    const { registry } = createRegistry();
    const produced = producer(undefined, { settleOnCancel: false });
    const id = registry.start(produced.spec);

    expect(registry.kill(id, undefined, "user asked")).toBe("requested");
    expect(registry.get(id).status).toBe("stopping");
    expect(produced.cancels).toStrictEqual(["user asked"]);

    produced.settle({ status: "killed", detail: "signal: SIGTERM" });
    const view = await registry.wait(id, 1000);

    expect(view).toMatchObject({
      status: "killed",
      detail: "signal: SIGTERM; user asked",
    });
    expect(registry.kill(id)).toBe("already-finished");
  });

  test("keeps the first settlement when a late producer outcome arrives", async () => {
    const { registry } = createRegistry();
    const gate = deferred<JobOutcome>();
    const statuses: string[] = [];
    registry.events.subscribe({ owners: "all" }, (event) => {
      if (event.type === "settled") {
        statuses.push(event.job.status);
      }
    });
    registry.start({
      kind: "bash",
      label: "stuck",
      owner: "alice",
      run: () => ({
        cancel: () => {
          throw new Error("cancel refused");
        },
        done: gate.promise,
      }),
    });

    // cancel 抛错后注册表强制判为 failed，这是唯一一个终态。
    await registry.disposeOwner("alice");

    gate.resolve({ status: "completed" });
    await flush();

    expect(statuses).toStrictEqual(["failed"]);
  });

  test("settles failed when the producer's done promise rejects", async () => {
    const { registry, warnings } = createRegistry();
    const id = registry.start({
      kind: "bash",
      label: "bad",
      run: () => ({
        cancel: () => {},
        done: Promise.reject(new Error("boom")),
      }),
    });

    const view = await registry.wait(id, 1000);

    expect(view.status).toBe("failed");
    expect(view.detail).toBe("Error: boom");
    expect(
      warnings.some((message) =>
        message.includes("producer done promise rejected")
      )
    ).toBeTruthy();
  });

  test("removes only a settled job", async () => {
    const { registry } = createRegistry();
    const { events } = collectEvents(registry);
    const produced = producer();
    const id = registry.start(produced.spec);

    expect(() => registry.remove(id)).toThrow("is still running");

    produced.settle({ status: "completed" });
    await registry.wait(id, 1000);
    registry.remove(id);

    expect(registry.list()).toStrictEqual([]);
    expect(events.map((event) => event.type)).toContain("removed");
    expect(() => registry.remove(id)).toThrow("unknown job");
  });

  test("owner disposal cancels and drops only that owner's jobs", async () => {
    const { registry } = createRegistry();
    const alice = producer({ owner: "alice" });
    const bob = producer({ owner: "bob" });
    registry.start(alice.spec);
    const bobId = registry.start(bob.spec);

    await registry.disposeOwner("alice");

    expect(alice.cancels).toStrictEqual(["owner disposed"]);
    expect(bob.cancels).toStrictEqual([]);
    expect(registry.list("alice")).toStrictEqual([]);
    expect(registry.list("bob").map((job) => job.id)).toStrictEqual([bobId]);
  });

  test("registry disposal cancels every job and announces a teardown settlement", async () => {
    const { registry } = createRegistry();
    const causes: string[] = [];
    registry.events.subscribe({ owners: "all" }, (event) => {
      if (event.type === "settled") {
        causes.push(event.cause);
      }
    });
    const produced = producer();
    registry.start(produced.spec);

    await registry.dispose();

    expect(causes).toStrictEqual(["teardown"]);
    expect(produced.cancels).toStrictEqual(["registry disposed"]);
    expect(registry.list()).toStrictEqual([]);
  });
});

describe("JobRegistry 输出", () => {
  test("publishes output staged inside the starter only after the commit", () => {
    const { registry } = createRegistry();
    const { events } = collectEvents(registry);
    const gate = deferred<JobOutcome>();
    const id = registry.start({
      kind: "bash",
      label: "staged",
      run: (job) => {
        job.append("one\n");
        job.append("two\n");
        return { cancel: () => {}, done: gate.promise };
      },
    });

    expect(events.map((event) => event.type)).toStrictEqual(["registered"]);
    expect(registry.read(id).chunks.map((chunk) => chunk.text)).toStrictEqual([
      "one\n",
      "two\n",
    ]);
    expect(registry.read(id).chunks).toStrictEqual([]);
  });

  test("emits an output event for an append after the commit", () => {
    const { registry } = createRegistry();
    const { events } = collectEvents(registry);
    const produced = producer();
    registry.start(produced.spec);

    produced.handle?.append("late");

    expect(events.map((event) => event.type)).toStrictEqual([
      "registered",
      "output",
    ]);
  });

  test("hands the producer's result out once after settlement", async () => {
    const { registry } = createRegistry();
    const produced = producer();
    const id = registry.start(produced.spec);
    produced.handle?.append("out");

    produced.settle({ status: "completed", result: "final" });
    await registry.wait(id, 1000);

    expect(registry.read(id).result).toBe("final");
    expect(registry.read(id).result).toBeUndefined();
  });

  test("readAt never moves the model cursor", () => {
    const { registry } = createRegistry();
    const produced = producer();
    const id = registry.start(produced.spec);
    produced.handle?.append("hello");

    const observed = registry.readAt(id, 0);

    expect({
      chunks: observed.chunks.map((chunk) => chunk.text),
      next: observed.next,
      lossy: observed.lossy,
    }).toStrictEqual({ chunks: ["hello"], next: 5, lossy: false });
    expect(registry.read(id).chunks.map((chunk) => chunk.text)).toStrictEqual([
      "hello",
    ]);
    expect(registry.readAt(id, 5).chunks).toStrictEqual([]);
    expect(registry.readAt(id, 2).chunks[0]?.at).toBe(0);
  });

  test("rejects an invalid output offset", () => {
    const { registry } = createRegistry();
    const id = registry.start(producer().spec);

    expect(() => registry.readAt(id, -1)).toThrow("invalid output read offset");
    expect(() => registry.readAt(id, 1.5)).toThrow(
      "invalid output read offset"
    );
  });

  test("pumps a pull source into the ring", async () => {
    const { registry } = createRegistry();
    let reads = 0;
    const source: JobOutputSource = {
      channel: "stdout",
      read: (fromByte) => {
        reads += 1;
        return reads === 1
          ? { text: "hello", nextOffset: fromByte + 5, lossy: false }
          : { text: "", nextOffset: fromByte, lossy: false };
      },
    };
    const produced = producer({ output: [source] });
    const id = registry.start(produced.spec);

    expect(registry.read(id).chunks.map((chunk) => chunk.text)).toStrictEqual([
      "hello",
    ]);

    produced.settle({ status: "completed" });
    await registry.wait(id, 1000);

    expect(reads).toBeGreaterThanOrEqual(2);
  });

  test("marks a lossy source read and reports its spill file", async () => {
    const { registry } = createRegistry();
    const source: JobOutputSource = {
      read: (fromByte) => ({
        text: "tail",
        nextOffset: fromByte + 4,
        lossy: true,
        spillPath: "/tmp/out.log",
      }),
    };
    const produced = producer({ output: [source] });
    const id = registry.start(produced.spec);

    const read = registry.read(id);

    expect(read.chunks[0]?.gapBefore).toBeTruthy();
    expect(read.job.output.spillPaths).toStrictEqual(["/tmp/out.log"]);

    produced.settle({ status: "completed" });
    await registry.wait(id, 1000);
  });

  test("drops a producer append after settlement and warns", async () => {
    const { registry, warnings } = createRegistry();
    const produced = producer();
    const id = registry.start(produced.spec);
    produced.settle({ status: "completed" });
    await registry.wait(id, 1000);

    produced.handle?.append("late");

    expect(registry.read(id).chunks).toStrictEqual([]);
    expect(
      warnings.some((message) => message.includes("append to settled job"))
    ).toBeTruthy();
  });
});

describe("JobRegistry 等待与事件", () => {
  test("a timed-out wait returns the running view without killing the job", async () => {
    const { registry } = createRegistry();
    const produced = producer();
    const id = registry.start(produced.spec);

    const view = await registry.wait(id, 20);

    expect(view.status).toBe("running");
    expect(produced.cancels).toStrictEqual([]);

    produced.settle({ status: "completed" });
    await registry.wait(id, 1000);
  });

  test("a caller abort rejects the wait but leaves the job alive", async () => {
    const { registry } = createRegistry();
    const produced = producer();
    const id = registry.start(produced.spec);
    const controller = new AbortController();
    const waiting = registry.wait(id, 1000, undefined, controller.signal);

    controller.abort();

    await expect(waiting).rejects.toThrow("wait aborted");
    expect(registry.get(id).status).toBe("running");

    const aborted = new AbortController();
    aborted.abort();
    await expect(
      registry.wait(id, 1000, undefined, aborted.signal)
    ).rejects.toThrow("wait aborted");

    produced.settle({ status: "completed" });
    await registry.wait(id, 1000);
  });

  test("announces registered, output, settled, and removed in order", async () => {
    const { registry } = createRegistry();
    const { events } = collectEvents(registry);
    const produced = producer();
    const id = registry.start(produced.spec);
    produced.handle?.append("x");
    produced.settle({ status: "completed" });
    await registry.wait(id, 1000);
    registry.remove(id);

    expect(events.map((event) => event.type)).toStrictEqual([
      "registered",
      "output",
      "settled",
      "output",
      "removed",
    ]);
  });

  test("delivers { owner } subscriptions that owner's jobs plus unowned ones", () => {
    const { registry } = createRegistry();
    const seen: string[] = [];
    registry.events.subscribe({ owner: "alice" }, (event) => {
      if (event.type === "registered") {
        seen.push(event.job.id);
      }
    });
    const alice = producer({ owner: "alice" });
    const bob = producer({ owner: "bob" });
    const open = producer();
    const aliceId = registry.start(alice.spec);
    const bobId = registry.start(bob.spec);
    const openId = registry.start(open.spec);

    expect(seen).toStrictEqual([aliceId, openId]);
    expect(seen).not.toContain(bobId);
  });

  test("contains a throwing listener without starving the others", () => {
    const { registry, warnings } = createRegistry();
    const seen: string[] = [];
    registry.events.subscribe({ owners: "all" }, () => {
      throw new Error("boom");
    });
    registry.events.subscribe({ owners: "all" }, (event) => {
      seen.push(event.type);
    });

    registry.start(producer().spec);

    expect(seen).toStrictEqual(["registered"]);
    expect(
      warnings.some((message) => message.includes("event listener threw"))
    ).toBeTruthy();
  });
});
