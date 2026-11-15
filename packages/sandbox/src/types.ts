/**
 * 沙箱是工具读写文件和运行命令的那个运行环境。它可能是本机，也可能是容器或
 * 远端机器；工具只认这一个面，看不出区别。
 */

/**
 * 沙箱能跑的 shell 方言。
 *
 * `cmd` 只在 Windows 上出现，没有对应工具：它是 `exec` 省略方言时的兜底。
 * 一个方言缺哪种，对应的工具就不注册。
 */
export type ShellKind = "bash" | "powershell" | "cmd";

/** 沙箱对模型的自我描述。`Environment` 提示从它取值，不写死宿主路径。 */
export interface SandboxDescription {
  /** 具体机制的名字：`host`、`seatbelt`、`bwrap`，或某个远端适配器自己的名字。 */
  readonly backend: string;
  /** 相对路径的基准目录。 */
  readonly cwd: string;
  /** 沙箱能碰到的根目录，`cwd` 通常在第一项。 */
  readonly roots: readonly string[];
  /**
   * 这个沙箱能跑的 shell 方言。空数组表示只能读写文件。没有对应工具的方言
   * （Windows 的 `cmd`）也在里面：它描述能力，不描述模型的工具箱。
   */
  readonly shells: readonly ShellKind[];
  /**
   * 给模型看的一句话，说明这个环境的约束。省略时不渲染——本机直跑没有值得
   * 提前告诉模型的限制，加进去只会让系统提示变长。
   */
  readonly note?: string;
}

export interface ExecOptions {
  /** 命令的工作目录；省略用 `describe().cwd`。 */
  cwd?: string;
  /** 环境变量覆盖，合并到适配器的基础环境之上。 */
  env?: NodeJS.ProcessEnv;
  /** 截止时间，毫秒。到点终止进程，结果里 `timedOut` 为 true。 */
  timeoutMs?: number;
  /** 调用方取消。结果里 `aborted` 为 true，不抛——工具读这个字段。 */
  signal?: AbortSignal;
  /** 方言，省略用适配器的默认（本机适配器：能跑 bash 用 bash，Windows 退回 cmd）。 */
  shell?: ShellKind;
  /** 输出增量。不传就只关心结局（退出码、超时、取消），输出不会进结果。 */
  onData?: (channel: "stdout" | "stderr", chunk: Buffer) => void;
}

/**
 * 一次命令的结局。
 *
 * 命令跑完就是结果，非零退出码、超时、取消都用字段表达，不抛；只有进程起不来
 * （可执行文件或目录不存在、权限不足）才 reject。
 */
export interface ExecResult {
  /** 被信号终止时是 `null`，信号名在 `signal`。 */
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  aborted: boolean;
  durationMs: number;
}

/** 目录项。`isSymbolicLink` 为 true 时其余两项描述链接目标，除非目标是坏的。 */
export interface DirEntry {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
}

/**
 * 文件元数据。适配器拿不到的字段必须省略，不许填占位值——`stat` 给出的类型
 * 决定工具的分支，编造的值会把文件读坏。
 */
export interface FileStat {
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink?: boolean;
  size?: number;
  mtime?: Date;
}

export interface ExistsOptions {
  /** 还要可读（`R_OK`）。 */
  readable?: boolean;
  /** 还要可写（`W_OK`）。 */
  writable?: boolean;
}

export interface Sandbox {
  /** 当前环境的描述；远端适配器可能在启动后才有真值。 */
  describe(): SandboxDescription;

  /** 跑一条命令。 */
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;

  /** 按 UTF-8 读整个文本文件。 */
  readFile(path: string): Promise<string>;

  /** 读整个文件的字节。 */
  readFileBuffer(path: string): Promise<Uint8Array>;

  /** 写整个文件，父目录不存在时创建。 */
  writeFile(path: string, content: string | Uint8Array): Promise<void>;

  /** 文件元数据。路径不存在时 reject。 */
  stat(path: string): Promise<FileStat>;

  /** 列目录，顺序由适配器决定，调用方自己排。 */
  readdir(path: string): Promise<DirEntry[]>;

  /**
   * 路径是否存在。这个动词永不抛：不存在、读不了、权限不足都返回 `false`，
   * 调用方用 `stat` 区分原因。
   */
  exists(path: string, options?: ExistsOptions): Promise<boolean>;

  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;

  rm(
    path: string,
    options?: { recursive?: boolean; force?: boolean }
  ): Promise<void>;

  /**
   * 把路径归一化：相对路径按 `cwd` 解析，`~`、`@` 前缀和 `file://` 都接受。
   * 文件动词内部已经解析过一次，这个方法给需要绝对路径的调用方用。
   */
  resolvePath(path: string): string;

  /**
   * 可选能力：按行流式读文本。大文件的按行读取靠它避免整份进内存；没有这个
   * 能力时，调用方退到 `readFile` 再切行。
   */
  readTextStream?(path: string): AsyncIterable<string>;

  /**
   * 可选能力：只读文件开头的若干字节，用来嗅探类型。没有时调用方退到
   * `readFileBuffer` 再截断。
   */
  readHead?(path: string, bytes: number): Promise<Uint8Array>;
}

/** 取沙箱时的输入。会话身份、目录和上一次的物理 id 都在这里。 */
export interface AcquireSandboxInput {
  /** 沙箱 id：一个会话一个，由宿主分配。 */
  readonly id: string;
  /** 至少一项的项目目录，第一项是相对路径的基准。 */
  readonly projectDirs: readonly string[];
  /** 会话私有目录，存临时文件。 */
  readonly sessionDir: string;
  /** 上一次回报的物理 id。有了就尝试回到同一个环境，没有就是新建。 */
  readonly physicalId?: string;
}

export interface SandboxHandle {
  readonly sandbox: Sandbox;
  /**
   * 适配器那一侧的真实资源标识，用来下次重连同一个环境。本机适配器没有这个
   * 值，宿主因此不需要为它写库。
   */
  readonly physicalId?: string;
}

/** 把一个会话映射到某个环境的代码。一个适配器对应一种环境。 */
export interface SandboxAdapter {
  /**
   * 适配器名字，给宿主选择和日志用。按平台挑机制的适配器（例如原生隔离）在这里
   * 报 `isolated`，具体机制写在 `describe().backend`。
   */
  readonly name: string;

  /**
   * 取这个会话的沙箱。
   *
   * 有 `physicalId` 时先尝试重连；重连失败或没有 id 时新建。返回值里的
   * `physicalId` 覆盖输入，宿主据此更新持久化的标识。
   */
  acquire(input: AcquireSandboxInput): Promise<SandboxHandle>;
}
