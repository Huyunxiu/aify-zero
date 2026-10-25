import { randomUUID } from "node:crypto";

import { logger } from "@workspace/shared/logger";

import { JobEventHub } from "./events";
import { startPump } from "./pump";
import type { PumpHandle } from "./pump";
import { OutputRing } from "./ring";
import type {
  JobAppendOptions,
  JobEvent,
  JobEvents,
  JobHandle,
  JobId,
  JobOutcome,
  JobOutputRead,
  JobOutputSource,
  JobRead,
  JobSettleCause,
  JobSpec,
  JobStatus,
  JobView,
} from "./types";

const DEFAULT_MAX_CONCURRENT_JOBS_PER_OWNER = 10;
const DEFAULT_RETAIN_BYTES = 256 * 1024;
const DEFAULT_SETTLED_RETAIN_BYTES = 16 * 1024;
const DEFAULT_PUMP_POLL_MS = 150;

/** 注册表配置。全部有默认值，生产环境只用默认值即可。 */
export type JobRegistryOptions = {
  /**
   * 每个确切拥有者（以及共享的无主桶）允许同时处于 `running` 加 `stopping`
   * 的任务数，省略时 10。
   */
  maxConcurrentJobsPerOwner?: number;
  /** 每个任务运行期的输出保留上限，UTF-8 字节，省略时 262144。 */
  retainBytes?: number;
  /** 结算后保留的输出量，UTF-8 字节，省略时 16384。 */
  settledRetainBytes?: number;
  /** 拉取源的轮询间隔，毫秒，省略时 150。 */
  pumpPollMs?: number;
  /** 内部告警的落点；测试可以换成收集器。 */
  warn?: (message: string) => void;
};

/** 生产方写入的共享状态：starter 期间的写落在 `progress` 上，提交后再进记录。 */
type ProducerState = {
  /** 提交前写入的进度行。 */
  progress?: string;
  /** 注册表记录；恰好在 `run` 调用期间为 undefined。 */
  job?: TrackedJob;
};

/** 一条已登记的任务记录。 */
type TrackedJob = {
  readonly id: JobId;
  readonly kind: string;
  readonly label: string;
  readonly owner: string | undefined;
  status: JobStatus;
  detail: string | undefined;
  readonly startedAt: number;
  finishedAt: number | undefined;
  readonly ring: OutputRing;
  /** 模型侧消费游标，指向已经被模型读走的字节。 */
  modelCursor: number;
  result: string | undefined;
  resultDelivered: boolean;
  killReason: string | undefined;
  settleCause: JobSettleCause | undefined;
  readonly cancel: (reason?: string) => void;
  readonly state: ProducerState;
  /** 终态记录提交后 resolve。 */
  readonly settled: Promise<void>;
  readonly markSettled: () => void;
  /** 活着的等待方；超时或中止会先把自己摘掉。 */
  readonly waitResolvers: Set<() => void>;
  pump: PumpHandle | undefined;
  /** 每个拉取源最近一次读取报告的完整流文件，按源下标索引。 */
  readonly spillPaths: (string | undefined)[];
};

/** 三个终态之一。 */
const isTerminal = (status: JobStatus): boolean =>
  status === "completed" || status === "killed" || status === "failed";

const positiveInteger = (name: string, value: number): number => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(
      `invalid ${name}: expected a positive safe integer, got ${JSON.stringify(value)}`
    );
  }
  return value;
};

/**
 * 进程内后台任务注册表。
 *
 * 任务是“生产方声明 + 注册表记账”：生产方声明 kind、标签、拥有者和可选的
 * 拉取源，在 starter 里同步返回 `{ cancel, done }`；注册表拥有 id、归属、
 * 生命周期、输出环和事件。结算首次优先，结算之后记录保持可见，直到拥有者
 * 或整个注册表被销毁，或者调用方自己 `remove`。
 *
 * 归属以会话 id 为界。id 是可预测的，所以安全边界是授权而不是保密。
 */
export class JobRegistry {
  readonly #store = new Map<JobId, TrackedJob>();
  readonly #hub: JobEventHub;
  readonly #maxConcurrentJobsPerOwner: number;
  readonly #retainBytes: number;
  readonly #settledRetainBytes: number;
  readonly #pumpPollMs: number;
  readonly #warn: (message: string) => void;

  constructor(options: JobRegistryOptions = {}) {
    this.#maxConcurrentJobsPerOwner = positiveInteger(
      "maxConcurrentJobsPerOwner",
      options.maxConcurrentJobsPerOwner ?? DEFAULT_MAX_CONCURRENT_JOBS_PER_OWNER
    );
    this.#retainBytes = positiveInteger(
      "retainBytes",
      options.retainBytes ?? DEFAULT_RETAIN_BYTES
    );
    this.#settledRetainBytes = positiveInteger(
      "settledRetainBytes",
      options.settledRetainBytes ?? DEFAULT_SETTLED_RETAIN_BYTES
    );
    this.#pumpPollMs = options.pumpPollMs ?? DEFAULT_PUMP_POLL_MS;
    if (!Number.isFinite(this.#pumpPollMs) || this.#pumpPollMs <= 0) {
      throw new Error(
        `invalid pumpPollMs: expected a positive finite number of milliseconds, got ${JSON.stringify(this.#pumpPollMs)}`
      );
    }
    this.#warn =
      options.warn ??
      ((message) => {
        logger.warn(message);
      });
    this.#hub = new JobEventHub(this.#warn);
  }

  /** 生命周期与输出事件，按订阅条件过滤。 */
  get events(): JobEvents {
    return {
      subscribe: (filter, listener) => this.#hub.subscribe(filter, listener),
    };
  }

  /**
   * 做准入、校验与 id 签发，然后启动并原子地登记工作。任何准入拒绝都不留
   * id 和执行资源；starter 抛出时不留下任何记录，返回之后登记不能再失败。
   * @param spec - 身份、拥有者、输出源和同步 starter。
   * @returns 注册表签发的 `<kind>-<16 位十六进制>` id。
   */
  start(spec: JobSpec): JobId {
    if (spec.kind.length === 0) {
      throw new Error("invalid job kind: expected a non-empty string");
    }
    if (spec.label.length === 0) {
      throw new Error("invalid job label: expected a non-empty string");
    }
    if (spec.owner !== undefined && spec.owner.length === 0) {
      throw new Error("invalid job owner: expected a non-empty session id");
    }
    this.#assertCapacity(spec.owner);

    const id = this.#issueId(spec.kind);
    const ring = new OutputRing();
    const state: ProducerState = {};
    const handle: JobHandle = {
      id,
      append: (text, options) => {
        this.#appendRing(state, ring, text, options, "producer");
      },
      updateProgress: (line) => {
        this.#updateProgress(state, line);
      },
    };
    const hooks = spec.run(handle);

    let markSettled!: () => void;
    const settled = new Promise<void>((resolve) => {
      markSettled = resolve;
    });
    const job: TrackedJob = {
      id,
      kind: spec.kind,
      label: spec.label,
      owner: spec.owner,
      status: "running",
      detail: undefined,
      startedAt: Date.now(),
      finishedAt: undefined,
      ring,
      modelCursor: 0,
      result: undefined,
      resultDelivered: false,
      killReason: undefined,
      settleCause: undefined,
      cancel: (reason) => {
        hooks.cancel(reason);
      },
      state,
      settled,
      markSettled,
      waitResolvers: new Set(),
      pump: undefined,
      spillPaths: [],
    };
    // 绑定共享状态就是提交：starter 里写入的块已经在环里，提交之后的
    // handle 调用才会走到这条已登记的记录上。
    state.job = job;
    this.#store.set(id, job);
    // 登记已经完成，从这里开始不会失败，可见集合确实变了。公告排在泵之前，
    // 因为泵会同步抽干一次，那次抽干可能追加并公告输出：任务的第一条事件
    // 永远是 `registered`。
    this.#emit({ type: "registered", job: this.#view(job) }, job.owner);

    const producerDone = hooks.done.then(
      (outcome): JobOutcome => outcome,
      (error: unknown): JobOutcome => {
        // 生产方违约（`done` reject）不能挂死清理和等待方。
        this.#warn(
          `jobs: job ${id} producer done promise rejected (producer contract violation): ${String(error)}`
        );
        return { status: "failed", detail: String(error) };
      }
    );

    if (spec.output !== undefined && spec.output.length > 0) {
      job.pump = startPump(
        spec.output.map((source) => this.#guardSource(id, source)),
        {
          append: (text, options) => {
            this.#appendRing(state, ring, text, options, "pump");
          },
          spill: (index, path) => {
            job.spillPaths[index] = path;
          },
        },
        this.#pumpPollMs,
        Promise.race([producerDone, settled])
      );
    }

    void producerDone.then(async (outcome) => {
      if (job.pump !== undefined) {
        await job.pump.done;
      }
      this.#settle(job, outcome, job.settleCause ?? "producer");
    });

    return id;
  }

  /**
   * 按登记顺序列出调用方拥有的任务和无主任务。
   * @param caller - 读取方会话；省略时只看见无主任务。
   */
  list(caller?: string): JobView[] {
    return [...this.#store.values()]
      .filter((job) => job.owner === undefined || job.owner === caller)
      .map((job) => this.#view(job));
  }

  /**
   * 读取一个任务的投影，不改变任何游标。
   * @param id - 要查的任务。
   * @param caller - 读取方会话，校验归属。
   */
  get(id: JobId, caller?: string): JobView {
    return this.#view(this.#expect(id, caller));
  }

  /**
   * 从模型游标消费输出环，并把游标推到当前总量。结算后的第一次读取还会
   * 带上生产方的结果。
   * @param id - 要读的任务。
   * @param caller - 读取方会话，校验归属。
   */
  read(id: JobId, caller?: string): JobRead {
    return this.#readJob(this.#expect(id, caller));
  }

  /**
   * 读取保留的输出而不移动模型游标；用上一次的 `next` 续读。
   * @param id - 要读的任务。
   * @param from - 起始的绝对字节偏移，0 表示保留内容的开头。
   * @param caller - 读取方会话，校验归属。
   */
  readAt(id: JobId, from: number, caller?: string): JobOutputRead {
    const job = this.#expect(id, caller);
    if (!Number.isSafeInteger(from) || from < 0) {
      throw new Error(
        `invalid output read offset: expected a non-negative safe integer, got ${JSON.stringify(from)}`
      );
    }
    return job.ring.readFrom(from);
  }

  /**
   * 请求取消，然后把任务标记为停止中。
   * @param id - 要取消的任务。
   * @param caller - 调用方会话，校验归属。
   * @param reason - 原样转发给生产方的取消原因。
   * @returns 活着的任务返回 `requested`，否则 `already-finished`。
   */
  kill(
    id: JobId,
    caller?: string,
    reason?: string
  ): "requested" | "already-finished" {
    const job = this.#expect(id, caller);
    if (isTerminal(job.status)) {
      return "already-finished";
    }
    // 先取消：抛错时生命周期状态保持原样。
    job.cancel(reason);
    job.status = "stopping";
    // 最后一个原因生效：detail 报告最新的取消意图。
    if (reason !== undefined) {
      job.killReason = reason;
    }
    job.settleCause = "kill";
    this.#emit({ type: "stopping", job: this.#view(job) }, job.owner);
    return "requested";
  }

  /**
   * 等待结算或超时，不取消任务。调用方中止只在任务还活着时拒绝；已经结算
   * 的任务直接返回终态。
   * @param id - 要等待的任务。
   * @param timeoutMs - 正整数等待上限，毫秒。
   * @param caller - 等待方会话，校验归属。
   * @param signal - 可选，用来中止等待本身。
   */
  async wait(
    id: JobId,
    timeoutMs: number,
    caller?: string,
    signal?: AbortSignal
  ): Promise<JobView> {
    const job = this.#expect(id, caller);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error(
        `invalid wait timeout: expected a positive number of milliseconds, got ${JSON.stringify(timeoutMs)}`
      );
    }
    if (!isTerminal(job.status)) {
      if (signal?.aborted === true) {
        throw new Error("wait aborted");
      }
      await new Promise<void>((resolve, reject) => {
        let done = false;
        function finish(error?: Error): void {
          if (done) {
            return;
          }
          done = true;
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          job.waitResolvers.delete(onSettled);
          if (error === undefined) {
            resolve();
          } else {
            reject(error);
          }
        }
        function onSettled(): void {
          finish();
        }
        function onAbort(): void {
          finish(new Error("wait aborted"));
        }
        const timer = setTimeout(() => {
          finish();
        }, timeoutMs);
        job.waitResolvers.add(onSettled);
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
    return this.#view(job);
  }

  /**
   * 把一个已结算任务的记录从可见集合里删掉，并公告 `removed`。调用方自己
   * 收走了终态、并且没有把 id 交给模型时使用。
   * @param id - 要删除的已结算任务。
   * @param caller - 调用方会话，校验归属。
   */
  remove(id: JobId, caller?: string): void {
    const job = this.#expect(id, caller);
    if (!isTerminal(job.status)) {
      throw new Error(
        `job ${id} is still ${job.status}; kill it and wait for settlement before removing it`
      );
    }
    this.#drop([job]);
  }

  /**
   * 取消、等待并删除一个拥有者的全部任务。拥有者的会话结束时调用它。
   * @param owner - 要销毁的拥有者会话 id。
   */
  async disposeOwner(owner: string): Promise<void> {
    const owned = [...this.#store.values()].filter(
      (job) => job.owner === owner
    );
    this.#cancelForTeardown(owned, "owner disposed");
    await Promise.all(owned.map((job) => job.settled));
    this.#drop(owned);
  }

  /**
   * 取消、等待并删除全部任务。服务关闭时调用它。
   *
   * 一个始终不结算 `done` 的生产方会让这里挂住；这是生产方的约定义务，不是
   * 注册表可以替它决定的事。
   */
  async dispose(): Promise<void> {
    const all = [...this.#store.values()];
    this.#cancelForTeardown(all, "registry disposed");
    await Promise.all(all.map((job) => job.settled));
    this.#drop(all);
  }

  /** 投影一个新鲜的只读视图。 */
  #view(job: TrackedJob): JobView {
    const spillPaths = [
      ...new Set(
        job.spillPaths.filter((path): path is string => path !== undefined)
      ),
    ];
    return {
      id: job.id,
      kind: job.kind,
      label: job.label,
      ...(job.owner === undefined ? {} : { owner: job.owner }),
      status: job.status,
      ...(job.state.progress === undefined
        ? {}
        : { progress: job.state.progress }),
      ...(job.detail === undefined ? {} : { detail: job.detail }),
      startedAt: job.startedAt,
      ...(job.finishedAt === undefined ? {} : { finishedAt: job.finishedAt }),
      output: {
        total: job.ring.total,
        earliest: job.ring.earliest,
        ...(spillPaths.length === 0 ? {} : { spillPaths }),
      },
    };
  }

  /** 取出任务并校验归属。id 可预测，所以这里同时是授权点。 */
  #expect(id: JobId, caller?: string): TrackedJob {
    const job = this.#store.get(id);
    if (job === undefined) {
      throw new Error(`unknown job ${id}`);
    }
    if (job.owner !== undefined && job.owner !== caller) {
      throw new Error(`job ${id} belongs to another session`);
    }
    return job;
  }

  /** 统计一个确切拥有者（或无主共享桶）当前的活任务数。 */
  #assertCapacity(owner?: string): void {
    let active = 0;
    for (const job of this.#store.values()) {
      if (
        job.owner === owner &&
        (job.status === "running" || job.status === "stopping")
      ) {
        active += 1;
      }
    }
    if (active >= this.#maxConcurrentJobsPerOwner) {
      throw new Error(
        `background job limit reached for this owner (limit: ${this.#maxConcurrentJobsPerOwner}); wait for one to finish or stop it, then retry`
      );
    }
  }

  /** 签发一个当前未被占用的 id。 */
  #issueId(kind: string): JobId {
    let id: JobId;
    do {
      id = `${kind}-${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    } while (this.#store.has(id));
    return id;
  }

  /**
   * 消费输出环：结果搭在结算后的第一次读取上。终态读取也是结算流降到
   * 结算保留量的那个点——结算时留着模型没读走的全部字节，就为这一次读取。
   */
  #readJob(job: TrackedJob): JobRead {
    const read = job.ring.readFrom(job.modelCursor);
    job.modelCursor = job.ring.total;
    const result =
      isTerminal(job.status) && !job.resultDelivered ? job.result : undefined;
    if (result !== undefined) {
      job.resultDelivered = true;
    }
    if (isTerminal(job.status)) {
      job.ring.trim(this.#settledRetainBytes);
    }
    return {
      chunks: read.chunks,
      lossy: read.lossy,
      ...(result === undefined ? {} : { result }),
      job: this.#view(job),
    };
  }

  /**
   * 追加一块到输出环。已结算任务上的生产方写入会记日志并丢弃；注册表自己
   * 的泵在结算后静默抽干。starter 里写入的块会被保留但不通知观察者——提交
   * 时才发布。
   */
  #appendRing(
    state: ProducerState,
    ring: OutputRing,
    text: string,
    options: JobAppendOptions | undefined,
    writer: "producer" | "pump"
  ): void {
    const { job } = state;
    if (job !== undefined && isTerminal(job.status)) {
      if (writer === "producer") {
        this.#warn(`jobs: append to settled job ${job.id} dropped`);
      }
      return;
    }
    if (!ring.append(text, options, this.#retainBytes)) {
      return;
    }
    if (job !== undefined) {
      this.#emitOutput(job);
    }
  }

  /**
   * 通过生产方控制面替换实时进度行；已结算任务上的写入会记日志并丢弃。
   * starter 里的写入会成为登记投影的初值，但不通知观察者。
   */
  #updateProgress(state: ProducerState, line: string): void {
    const { job } = state;
    if (job !== undefined && isTerminal(job.status)) {
      this.#warn(`jobs: progress update on settled job ${job.id} dropped`);
      return;
    }
    state.progress = line;
    if (job !== undefined) {
      this.#emit({ type: "progress", job: this.#view(job) }, job.owner);
    }
  }

  /**
   * 记录第一个终态，释放等待方，然后公告结算。首次优先保护 teardown 的强制
   * 失败不被迟到的生产方结果覆盖。`settled` 事件排在每个被释放的等待方之后，
   * 并报告是否释放了一个：超时或中止的等待早已离开集合，只有仍然被欠着投影
   * 的等待才算数。
   */
  #settle(job: TrackedJob, outcome: JobOutcome, cause: JobSettleCause): void {
    if (isTerminal(job.status)) {
      return;
    }
    job.status = outcome.status;
    // 被 kill 的结算把记录下来的取消原因并入 detail：生产方的事实在前
    //（`signal: SIGTERM; user asked`）。跑赢了 kill 请求的任务保留生产方
    // 自己的 detail——那个原因描述的是一次没有落地的取消。
    if (outcome.status === "killed" && job.killReason !== undefined) {
      job.detail =
        outcome.detail === undefined
          ? job.killReason
          : `${outcome.detail}; ${job.killReason}`;
    } else if (outcome.detail !== undefined) {
      job.detail = outcome.detail;
    }
    job.state.progress = undefined;
    job.result = outcome.result;
    job.finishedAt = Date.now();
    // 结算结束这条流：在任何观察者读到终态投影之前裁到结算保留量，但不能
    // 低于模型游标还没消费的字节。第一次模型读取之前就结束的任务，会保留
    // 运行期上限内的全部内容直到那次读取。
    job.ring.trim(
      Math.max(this.#settledRetainBytes, job.ring.total - job.modelCursor)
    );
    const waitResolvers = [...job.waitResolvers];
    job.waitResolvers.clear();
    for (const resolveWait of waitResolvers) {
      resolveWait();
    }
    job.markSettled();
    this.#emit(
      {
        type: "settled",
        job: this.#view(job),
        cause,
        awaited: waitResolvers.length > 0,
      },
      job.owner
    );
    // 环的流随结算结束；信号排在已提交的结算之后，被它唤醒的观察者读到的
    // 是终态。
    this.#emitOutput(job);
  }

  /** 公告一个任务的环前进了（追加或结算）。 */
  #emitOutput(job: TrackedJob): void {
    this.#emit(
      {
        type: "output",
        id: job.id,
        ...(job.owner === undefined ? {} : { owner: job.owner }),
        total: job.ring.total,
      },
      job.owner
    );
  }

  #emit(event: JobEvent, owner?: string): void {
    this.#hub.emit(event, owner);
  }

  /** 删除已结算记录，并为每条公告唯一一个不随任务记录保存的可见性变化。 */
  #drop(jobs: readonly TrackedJob[]): void {
    for (const job of jobs) {
      this.#store.delete(job.id);
      this.#emit({ type: "removed", job: this.#view(job) }, job.owner);
    }
  }

  /**
   * 销毁期间取消任务，逐个隔离。cancel 抛错时把记录强制判为 failed，并报告
   * 可能成为孤儿的工作。
   */
  #cancelForTeardown(jobs: readonly TrackedJob[], reason: string): void {
    for (const job of jobs) {
      if (isTerminal(job.status)) {
        continue;
      }
      // 从这里开始无论谁结算，它的拥有者或服务都已经在销毁：结算公告
      // `teardown`，完成通知就不会再去找一个不存在的读者。
      job.settleCause = "teardown";
      try {
        job.cancel(reason);
        job.status = "stopping";
        this.#emit({ type: "stopping", job: this.#view(job) }, job.owner);
      } catch (error: unknown) {
        const detail = `cancel threw during teardown; work may be orphaned: ${String(error)}`;
        this.#warn(
          `jobs: cancel of ${job.id} threw during teardown; job record forced failed and work may be orphaned: ${String(error)}`
        );
        this.#settle(job, { status: "failed", detail }, "teardown");
      }
    }
  }

  /**
   * 隔离一个读取失败的拉取源：第一次抛错记日志，之后该源都读作已耗尽，
   * 让任务按自己的结算走完，而不是卡死在泵上。
   */
  #guardSource(id: JobId, source: JobOutputSource): JobOutputSource {
    let failed = false;
    return {
      ...(source.channel === undefined ? {} : { channel: source.channel }),
      read: (fromByte) => {
        if (failed) {
          return { text: "", nextOffset: fromByte, lossy: false };
        }
        try {
          return source.read(fromByte);
        } catch (error: unknown) {
          failed = true;
          this.#warn(
            `jobs: output source for ${id} failed; its stream stops here: ${String(error)}`
          );
          return { text: "", nextOffset: fromByte, lossy: false };
        }
      },
    };
  }
}
