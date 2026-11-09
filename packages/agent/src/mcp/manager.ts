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
  stale: boolean;
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
 * - `release` 到 0 之后留 `idleTimeoutMs` 再断开，下个回合接着用；
 * - 配置变了或 `invalidate` 之后，下一次 `acquire` 重建；
 * - 失败结果缓一个窗口，避免坏命令拖慢每个回合。
 */
export class McpManager {
  readonly #entries = new Map<string, Entry>();
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
   * 取一个服务器的工具快照，并把它钉住。
   *
   * 调用方在会话结束时必须 `release`。失败时不会增加引用计数，所以失败也
   * 可以照常 `release` —— 它只是一次空操作。
   */
  async acquire(server: McpServerConfig): Promise<McpServerSnapshot> {
    const entry = await this.#entry(server);
    entry.refs += 1;
    this.#clearIdle(entry);

    if (entry.status === "ready") {
      return { status: "ready", tools: entry.tools };
    }

    if (entry.status === "connecting" && entry.pending) {
      // 同一回合里两个会话同时装配：共用一次握手，不要再拉一个进程。
      return await entry.pending;
    }

    if (entry.status === "failed" && this.#withinFailureWindow(entry)) {
      entry.refs -= 1;
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

  /** 建连并取工具表；失败留在 entry 上，交给失败窗口。 */
  async #connect(entry: Entry): Promise<McpServerSnapshot> {
    try {
      const tools = await entry.connection.listTools();
      entry.tools = tools;
      entry.status = "ready";
      entry.error = undefined;
      return { status: "ready", tools };
    } catch (error) {
      entry.status = "failed";
      entry.failedAt = Date.now();
      entry.error = getErrorMessage(error);
      entry.refs -= 1;
      logger.warn(
        `[mcp] server "${entry.server.name}" failed to start: ${entry.error}`
      );
      await closeQuietly(entry.connection, entry.server.name);
      return { status: "failed", tools: [], error: entry.error };
    }
  }

  /** 放掉一次 `acquire`。引用计数到 0 时开始空闲计时。 */
  release(serverId: string): void {
    const entry = this.#entries.get(serverId);
    if (!entry) {
      return;
    }

    entry.refs = Math.max(0, entry.refs - 1);
    if (entry.refs === 0) {
      this.#scheduleIdle(entry);
    }
  }

  /**
   * 标记所有连接失效。
   *
   * 只打标记，不立刻断开：正在跑的回合手里的调用还要用它。下一次 `acquire`
   * 才重建。失败缓存也一起清掉，让用户改完配置能马上重试。
   */
  invalidate(): void {
    for (const entry of this.#entries.values()) {
      entry.stale = true;
      entry.status = "idle";
      entry.failedAt = undefined;
      entry.error = undefined;
      entry.tools = [];
    }
  }

  /** 调用一个工具。连接不在就报错，由工具层转成工具错误。 */
  async callTool(
    server: McpServerConfig,
    toolName: string,
    input: unknown,
    options: { abortSignal?: AbortSignal } = {}
  ): Promise<CallToolResult> {
    const entry = this.#entries.get(server.id);
    if (!entry || entry.status !== "ready") {
      throw new Error(`MCP server "${server.name}" is not connected`);
    }

    return await entry.connection.callTool(toolName, input, options);
  }

  /**
   * 从工具名找回它属于哪个服务器、带什么注解。
   *
   * 审批就靠这一眼：名字是唯一在调用时还带着的信息。
   */
  resolveTool(
    fullName: string
  ): { server: McpServerConfig; definition: McpToolDefinition } | undefined {
    const parsed = splitMcpToolName(fullName);
    if (!parsed) {
      return undefined;
    }

    for (const entry of this.#entries.values()) {
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
    const entries = [...this.#entries.values()];
    this.#entries.clear();

    await Promise.all(
      entries.map(async (entry) => {
        this.#clearIdle(entry);
        await closeQuietly(entry.connection, entry.server.name);
      })
    );
  }

  async #entry(server: McpServerConfig): Promise<Entry> {
    const existing = this.#entries.get(server.id);
    if (existing) {
      if (!existing.stale && sameConfig(existing.server, server)) {
        return existing;
      }
      await this.#drop(server.id, existing);
    }

    const entry: Entry = {
      server,
      connection: this.#createConnection(server),
      status: "idle",
      tools: [],
      refs: 0,
      stale: false,
    };
    this.#entries.set(server.id, entry);
    return entry;
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
      void this.#drop(entry.server.id, entry);
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

  async #drop(serverId: string, entry: Entry): Promise<void> {
    this.#clearIdle(entry);
    if (this.#entries.get(serverId) === entry) {
      this.#entries.delete(serverId);
    }
    if (this.#closed && entry.refs > 0) {
      return;
    }
    await closeQuietly(entry.connection, entry.server.name);
  }
}
