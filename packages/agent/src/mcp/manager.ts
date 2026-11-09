import type { CallToolResult } from "@ai-sdk/mcp";
import { getErrorMessage } from "@workspace/shared/errors";
import { logger } from "@workspace/shared/logger";

import type { McpServerConfig } from "./config";
import { splitMcpToolName } from "./config";
import type { McpToolDefinition } from "./connection";
import { McpConnection } from "./connection";

/** 没有会话在用之后，连接再留一会儿；太短会让下个回合重新握手。 */
const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

/** 建连失败后暂时不再重试的窗口，避免每回合都去撞一个坏命令。 */
const DEFAULT_FAILURE_RETRY_MS = 60 * 1000;

export type McpServerStatus = "idle" | "connecting" | "ready" | "failed";

/** 一行状态，给设置页看。 */
export type McpServerState = {
  id: string;
  name: string;
  status: McpServerStatus;
  toolCount: number;
  error?: string;
};

/** 一次装配拿到的工具快照。 */
export type McpServerSnapshot = {
  status: McpServerStatus;
  tools: readonly McpToolDefinition[];
  error?: string;
};

/**
 * 一次装配借到的连接。
 *
 * 引用计数跟着租约走，不跟着服务器 id 走：配置一改，旧连接会被新的一代取代，
 * 但正在跑的回合手里还拿着旧的租约。按 id 记账会让这次归还算到新连接头上，
 * 旧连接于是永远等不到「可以断开」的那一刻。
 */
export type McpLease = McpServerSnapshot & {
  /** 调用这个租约对应的连接；连接已经不在时抛错，由工具层转成工具错误。 */
  callTool(
    toolName: string,
    input: unknown,
    options?: { abortSignal?: AbortSignal }
  ): Promise<CallToolResult>;
  /** 归还一次 `acquire`。重复调用安全。 */
  release(): void;
};

/** 管理器只依赖这几个方法，测试可以塞一个内存实现进来。 */
export interface McpConnectionHandle {
  listTools(): Promise<readonly McpToolDefinition[]>;
  callTool(
    toolName: string,
    input: unknown,
    options?: { abortSignal?: AbortSignal }
  ): Promise<CallToolResult>;
  close(): Promise<void>;
}

export interface McpManagerOptions {
  /** 空闲多久之后断开，默认 5 分钟。 */
  idleTimeoutMs?: number;
  /** 失败后多久重试，默认 60 秒。 */
  failureRetryMs?: number;
  /** 建连超时，透传给连接。 */
  connectTimeoutMs?: number;
  /** 测试用：替换连接的构造方式。 */
  createConnection?: (server: McpServerConfig) => McpConnectionHandle;
}

type Entry = {
  server: McpServerConfig;
  connection: McpConnectionHandle;
  status: McpServerStatus;
  tools: readonly McpToolDefinition[];
  error?: string;
  refs: number;
  /** 配置变了或 `invalidate` 过：下一次 `acquire` 换新的一代。 */
  stale: boolean;
  /** 已被新的一代取代：最后一个租约归还时才断开。 */
  retired: boolean;
  failedAt?: number;
  idleTimer?: ReturnType<typeof setTimeout>;
  /** 正在进行的建连与列工具；并发 acquire 共用它。 */
  pending?: Promise<McpServerSnapshot>;
};

function sameConfig(a: McpServerConfig, b: McpServerConfig): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** 关闭失败不该打断退出：连接已经没有用了，记一笔就够。 */
async function closeQuietly(
  connection: McpConnectionHandle,
  serverName: string
): Promise<void> {
  try {
    await connection.close();
  } catch (error) {
    logger.warn(`[mcp] failed to close server "${serverName}"`, error);
  }
}

/**
 * 进程级的 MCP 连接管理器。
 *
 * 会话每回合都会重新装配 agent，连接放在这里才不会被反复拉起。生命周期规则：
 *
 * - 第一次 `acquire` 时建连，之后同一份配置复用；
 * - 最后一个租约 `release` 之后留 `idleTimeoutMs` 再断开，下个回合接着用；
 * - 配置变了或 `invalidate` 之后，下一次 `acquire` 建新的一代，旧的一代等
 *   持有它的回合归还，不在中途断开；
 * - 失败结果缓一个窗口，避免坏命令拖慢每个回合。
 */
export class McpManager {
  readonly #entries = new Map<string, Entry>();
  /** 被取代但还有租约没还的旧连接。 */
  readonly #retired = new Set<Entry>();
  readonly #createConnection: (server: McpServerConfig) => McpConnectionHandle;
  readonly #idleTimeoutMs: number;
  readonly #failureRetryMs: number;
  #closed = false;

  constructor(options: McpManagerOptions = {}) {
    this.#idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.#failureRetryMs = options.failureRetryMs ?? DEFAULT_FAILURE_RETRY_MS;
    this.#createConnection =
      options.createConnection ??
      ((server) =>
        new McpConnection(server, {
          connectTimeoutMs: options.connectTimeoutMs,
        }));
  }

  /**
   * 取一个服务器的工具快照，并借出一个租约。
   *
   * 调用方在会话结束时必须 `release`。建连失败也返回租约，只是 `status` 为
   * `failed`、`tools` 为空；这样「失败」和「成功」走同一条归还路径，引用计数
   * 不会因为分支不同而失衡。
   */
  async acquire(server: McpServerConfig): Promise<McpLease> {
    if (this.#closed) {
      // 进程正在退出：不再拉起子进程，但没有工具这件事不该变成异常。
      return {
        status: "failed",
        tools: [],
        error: "MCP manager is closed",
        callTool: () => Promise.reject(new Error("MCP manager is closed")),
        release: () => {
          // 没有借到东西，不必归还。
        },
      };
    }

    const entry = this.#entry(server);
    entry.refs += 1;
    this.#clearIdle(entry);

    const snapshot = await this.#snapshot(entry);
    return this.#lease(entry, snapshot);
  }

  /**
   * 标记所有连接失效。
   *
   * 只打标记，不动连接和工具表：正在跑的回合手里的调用还要用它，审批也要靠
   * 旧工具表认出注解。下一次 `acquire` 才建新的一代，旧的一代等租约归还后
   * 关闭。失败窗口也一起清掉，让用户改完配置能马上重试。
   */
  invalidate(): void {
    for (const entry of this.#entries.values()) {
      entry.stale = true;
      entry.failedAt = undefined;
    }
  }

  /**
   * 从工具名找回它属于哪个服务器、带什么注解。
   *
   * 审批就靠这一眼：名字是唯一在调用时还带着的信息。旧一代的连接也要查，
   * 否则配置保存后，正在跑的回合会突然「查不到注解」。
   */
  resolveTool(
    fullName: string
  ): { server: McpServerConfig; definition: McpToolDefinition } | undefined {
    const parsed = splitMcpToolName(fullName);
    if (!parsed) {
      return undefined;
    }

    for (const entry of this.#knownEntries()) {
      if (entry.server.name !== parsed.serverName) {
        continue;
      }

      const definition = entry.tools.find(
        (tool) => tool.name === parsed.toolName
      );
      if (definition) {
        return { server: entry.server, definition };
      }
    }

    return undefined;
  }

  /** 这个前缀是不是一个已知的服务器；用来区分「别人的工具」和「自己的旧工具」。 */
  hasServer(serverName: string): boolean {
    return this.#knownEntries().some(
      (entry) => entry.server.name === serverName
    );
  }

  /** 每个已配置服务器一行状态；没连过的算 `idle`。 */
  statuses(servers: readonly McpServerConfig[] = []): McpServerState[] {
    return servers.map((server) => {
      const entry = this.#entries.get(server.id);
      return {
        id: server.id,
        name: server.name,
        status: entry?.status ?? "idle",
        toolCount: entry?.tools.length ?? 0,
        error: entry?.error,
      };
    });
  }

  /**
   * 试连一次：起一个临时连接，列工具，然后立刻收掉。
   *
   * 不改动已有连接，所以编辑弹窗里可以随便试。
   */
  async test(
    server: McpServerConfig
  ): Promise<{ ok: boolean; toolCount: number; error?: string }> {
    const connection = this.#createConnection(server);

    try {
      const tools = await connection.listTools();
      return { ok: true, toolCount: tools.length };
    } catch (error) {
      return { ok: false, toolCount: 0, error: getErrorMessage(error) };
    } finally {
      await closeQuietly(connection, server.name);
    }
  }

  /** 收掉所有连接。进程退出时调用。 */
  async close(): Promise<void> {
    this.#closed = true;
    const entries = [...this.#knownEntries()];
    this.#entries.clear();
    this.#retired.clear();

    await Promise.all(entries.map((entry) => this.#closeEntry(entry)));
  }

  #lease(entry: Entry, snapshot: McpServerSnapshot): McpLease {
    let released = false;

    return {
      status: snapshot.status,
      tools: snapshot.tools,
      error: snapshot.error,
      callTool: async (toolName, input, options) => {
        if (entry.status !== "ready") {
          throw new Error(`MCP server "${entry.server.name}" is not connected`);
        }
        return await entry.connection.callTool(toolName, input, options);
      },
      release: () => {
        if (released) {
          return;
        }
        released = true;
        this.#release(entry);
      },
    };
  }

  /** 建连并取工具表；失败留在 entry 上，交给失败窗口。 */
  async #snapshot(entry: Entry): Promise<McpServerSnapshot> {
    if (entry.status === "ready") {
      return { status: "ready", tools: entry.tools };
    }

    if (entry.status === "connecting" && entry.pending) {
      // 同一回合里两个会话同时装配：共用一次握手，不要再拉一个进程。
      return await entry.pending;
    }

    if (entry.status === "failed" && this.#withinFailureWindow(entry)) {
      return { status: "failed", tools: [], error: entry.error };
    }

    entry.status = "connecting";
    entry.pending = this.#connect(entry);
    try {
      return await entry.pending;
    } finally {
      entry.pending = undefined;
    }
  }

  async #connect(entry: Entry): Promise<McpServerSnapshot> {
    try {
      const tools = await entry.connection.listTools();
      entry.tools = tools;
      entry.status = "ready";
      entry.error = undefined;
      entry.failedAt = undefined;
      return { status: "ready", tools };
    } catch (error) {
      entry.status = "failed";
      entry.failedAt = Date.now();
      entry.error = getErrorMessage(error);
      logger.warn(
        `[mcp] server "${entry.server.name}" failed to start: ${entry.error}`
      );
      await closeQuietly(entry.connection, entry.server.name);
      return { status: "failed", tools: [], error: entry.error };
    }
  }

  /** 归还一次借出。引用归零时，被取代的连接立刻断，其余等空闲计时。 */
  #release(entry: Entry): void {
    entry.refs = Math.max(0, entry.refs - 1);
    if (entry.refs > 0) {
      return;
    }

    if (entry.retired) {
      void this.#closeEntry(entry);
      return;
    }

    this.#scheduleIdle(entry);
  }

  /** 取当前一代；配置变了或被标记失效就先换代。 */
  #entry(server: McpServerConfig): Entry {
    const existing = this.#entries.get(server.id);
    if (existing) {
      if (!existing.stale && sameConfig(existing.server, server)) {
        return existing;
      }
      this.#retire(existing);
    }

    const entry: Entry = {
      server,
      connection: this.#createConnection(server),
      status: "idle",
      tools: [],
      refs: 0,
      stale: false,
      retired: false,
    };
    this.#entries.set(server.id, entry);
    return entry;
  }

  /**
   * 把一代连接标记为被取代。
   *
   * 没有租约时立刻断开；还有租约时只登记，等最后一个 `release` 再断——中途
   * 断开会让正在跑的回合在调用工具时撞上「not connected」。
   */
  #retire(entry: Entry): void {
    entry.retired = true;
    entry.stale = true;
    this.#clearIdle(entry);
    if (this.#entries.get(entry.server.id) === entry) {
      this.#entries.delete(entry.server.id);
    }

    if (entry.refs === 0) {
      void this.#closeEntry(entry);
      return;
    }

    this.#retired.add(entry);
  }

  #knownEntries(): Entry[] {
    return [...this.#entries.values(), ...this.#retired];
  }

  #withinFailureWindow(entry: Entry): boolean {
    return (
      entry.failedAt !== undefined &&
      Date.now() - entry.failedAt < this.#failureRetryMs
    );
  }

  #scheduleIdle(entry: Entry): void {
    this.#clearIdle(entry);
    const timer = setTimeout(() => {
      if (entry.refs > 0) {
        return;
      }
      void this.#closeEntry(entry);
    }, this.#idleTimeoutMs);
    // 不要让一个空闲计时器拖住进程退出。
    timer.unref?.();
    entry.idleTimer = timer;
  }

  #clearIdle(entry: Entry): void {
    if (entry.idleTimer !== undefined) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = undefined;
    }
  }

  async #closeEntry(entry: Entry): Promise<void> {
    this.#clearIdle(entry);
    if (this.#entries.get(entry.server.id) === entry) {
      this.#entries.delete(entry.server.id);
    }
    this.#retired.delete(entry);
    await closeQuietly(entry.connection, entry.server.name);
  }
}
