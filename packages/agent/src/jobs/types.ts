/**
 * 后台任务（job）的公共词汇。生产方、注册表和后续的模型侧工具共用这一份
 * 类型：注册表拥有身份、归属与生命周期，生产方只拥有自己占用的执行资源。
 *
 * 时间戳都是毫秒；偏移和长度都是 UTF-8 字节，不是字符下标。
 */

/** 注册表签发的任务 id，形如 `<kind>-<16 位小写十六进制>`。 */
export type JobId = string;

/** 任务生命周期：运行中，可选的停止中，然后恰好一个终态。 */
export type JobStatus =
  | "running"
  | "stopping"
  | "completed"
  | "killed"
  | "failed";

/** 结算的触发方：生产方自己结束、外部 kill、或者所有权/服务销毁。 */
export type JobSettleCause = "producer" | "kill" | "teardown";

/**
 * 输出块的流标签。`stdout` 和 `stderr` 会进模型的消费式读取；`log` 是生产
 * 方的旁白，只给观察者看。
 */
export type JobChannel = "stdout" | "stderr" | "log";

/** 追加输出时的可选项。 */
export type JobAppendOptions = {
  /** 该块所属的流。 */
  channel?: JobChannel;
  /** 标记生产方在这块之前丢了字节，让观察者看到断点而不是静默拼接。 */
  gapBefore?: true;
};

/** 输出环里的一块：绝对偏移、原文、流标签和丢失标记。 */
export type JobChunk = {
  /** 这一块首字节的绝对偏移；一旦分配就不再移动。 */
  readonly at: number;
  /** 该块的原文。 */
  readonly text: string;
  /** 流标签，生产方没有区分流时省略。 */
  readonly channel?: JobChannel;
  /** 这一块之前的字节已丢失，可能是生产方丢的，也可能是保留上限裁掉的。 */
  readonly gapBefore?: true;
};

/** 一次非消耗式源读取的结果。 */
export type JobSourceRead = {
  /** 自请求偏移以来捕获到的文本；源已经丢失时返回保留的整段尾巴。 */
  text: string;
  /** 下一次读取用的整条流偏移。 */
  nextOffset: number;
  /** 请求的偏移已经滑出源的保留窗口。 */
  lossy: boolean;
  /** 源当前保留完整流时，那个文件的宿主路径。 */
  spillPath?: string;
};

/**
 * 注册表按自己的节奏泵进输出环的拉取源，对应子进程的 `readFrom` 系列。
 * 注册表拥有节奏，并在结算前再抽干一次，所以生产方不需要把尾巴塞进 `done`。
 */
export type JobOutputSource = {
  /** 该源产出的每块都带上这个流标签。 */
  channel?: JobChannel;
  /**
   * 读取自 `fromByte` 起捕获到的全部内容，不消耗它。
   * @param fromByte - 整条流上的绝对字节偏移；第一次传 0。
   */
  read(fromByte: number): JobSourceRead;
};

/** 生产方通过 `done` 交回的终态结果。 */
export type JobOutcome = {
  /** 结束方式：正常完成、被取消、或者出错。 */
  status: "completed" | "killed" | "failed";
  /** 终态原因，会渲染进状态行（`exit code: 3`）。 */
  detail?: string;
  /**
   * 结果是“值”而不是“流”时的返回值（工作流的渲染结果、子 agent 的报告）。
   * 输出环只装流，这个值由结算后的第一次模型读取交付一次。
   */
  result?: string;
};

/** 注册表发给生产方的一条任务控制面，在任务整个生命周期内有效。 */
export type JobHandle = {
  /** 注册表签发的 id。 */
  readonly id: JobId;
  /**
   * 往输出环追加一块；偏移按 UTF-8 字节推进，空块被丢弃。
   * 结算之后的写入只记录日志并丢弃，不抛错，避免生产方收尾时炸掉自己。
   * @param text - 按原样产出的块文本。
   * @param options - 流标签与丢失标记。
   */
  append(text: string, options?: JobAppendOptions): void;
  /**
   * 替换实时进度行（`3/10`、当前阶段）；结算时清空，终态原因走 `detail`。
   * @param line - 新的进度行。
   */
  updateProgress(line: string): void;
};

/** 注册表用来控制和观察生产方工作的钩子。 */
export type JobHooks = {
  /**
   * 请求终止。必须同步、可重入，并最终结算 `done`；抛错会传给调用方。
   * @param reason - 取消原因，原样转发给生产方。
   */
  cancel(reason?: string): void;
  /**
   * 生产方释放资源后 resolve，而不是工作刚结束时。不得 reject。
   */
  done: Promise<JobOutcome>;
};

/**
 * 生产方交给注册表的声明。注册表先做归属与准入检查，再用任务控制面调用
 * `run`；此后执行资源归生产方，身份、归属、生命周期与输出环归注册表。
 */
export type JobSpec = {
  /** 生产方种类，同时也是 id 前缀（`bash`、`pty-send`）。 */
  kind: string;
  /** 一行给模型看的标签（命令本身、派发描述）。 */
  label: string;
  /** 拥有者会话 id；归属校验以它为界，省略则创建无主任务。 */
  owner?: string;
  /** 注册表按自己的节奏泵进输出环的拉取源。 */
  output?: readonly JobOutputSource[];
  /**
   * 在准入之后启动工作，并同步返回钩子。调用一次；抛出时注册表不留下任何
   * 记录，生产方要自己清理已经启动了一半的资源。
   * @param job - 签发好的 id，加上输出环与进度行的写入口。
   */
  run(job: JobHandle): JobHooks;
};

/** 输出环的当前水位，观察者用它决定从哪个偏移续读。 */
export type JobOutputState = {
  /** 累计追加过的字节数，也就是下一块的起始偏移。 */
  total: number;
  /** 仍然保留着的最早字节偏移；没有保留内容时等于 `total`。 */
  earliest: number;
  /** 各拉取源当前保留的完整流文件。 */
  spillPaths?: readonly string[];
};

/** 一个任务的只读投影；每次读取都是新对象，不是活的注册表状态。 */
export type JobView = {
  id: JobId;
  kind: string;
  label: string;
  /** 拥有者会话；无主任务省略。 */
  owner?: string;
  status: JobStatus;
  /** 生产方的实时进度行；结算后清空。 */
  progress?: string;
  /** 终态原因；被 kill 时合并取消原因。 */
  detail?: string;
  startedAt: number;
  finishedAt?: number;
  output: JobOutputState;
};

/** 一次消费式读取的结果。 */
export type JobRead = {
  /** 自模型游标以来的所有块，按偏移顺序；所有流都在里面。 */
  chunks: readonly JobChunk[];
  /** 游标落在最早保留字节之前，说明 `chunks` 之前有字节已经丢了。 */
  lossy: boolean;
  /** 生产方的 `result`，只在结算后的第一次读取交付一次。 */
  result?: string;
  /** 读取时的任务状态。 */
  job: JobView;
};

/** 一次非消耗式读取的结果。 */
export type JobOutputRead = {
  /** 与 `[from, total)` 相交的保留块，按偏移顺序。 */
  chunks: readonly JobChunk[];
  /** 续读偏移，总是块边界。 */
  next: number;
  /** `from` 落在最早保留字节之前。 */
  lossy: boolean;
};

/**
 * 一个生命周期或输出事件。生命周期事件带上提交后的投影；`output` 只带
 * id 和新的总量，观察者自己去 `readAt`，注册表不推载荷。
 */
export type JobEvent =
  | {
      type: "registered" | "progress" | "stopping" | "removed";
      job: JobView;
    }
  | {
      type: "settled";
      job: JobView;
      cause: JobSettleCause;
      /**
       * 这次结算是否释放了一个活着的 `wait`。那个等待方自己会拿到终态投影，
       * 所以完成通知要跳过它，避免同一件事说两遍。
       */
      awaited: boolean;
    }
  | {
      type: "output";
      id: JobId;
      /** 拥有者会话；无主任务省略。 */
      owner?: string;
      /** 追加之后（或结算时）环的总量。 */
      total: number;
    };

/**
 * 订阅关心谁的事件。`{ owner }` 收到该会话的任务以及所有无主任务，也就是
 * 该会话能看见的集合。
 */
export type JobEventFilter = { owner: string } | { owners: "all" };

/** 事件回调；由注册表隔离，永不被等待。 */
export type JobEventListener = (event: JobEvent) => void;

/** 注册表的事件流。 */
export type JobEvents = {
  /**
   * 注册一个监听器。
   * @param filter - 投递哪些拥有者的事件。
   * @param listener - 每个匹配事件调用一次。
   * @returns 注销该监听器的函数。
   */
  subscribe(filter: JobEventFilter, listener: JobEventListener): () => void;
};
