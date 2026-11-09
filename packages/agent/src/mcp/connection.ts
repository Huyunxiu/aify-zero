import { createMCPClient } from "@ai-sdk/mcp";
import type {
  CallToolResult,
  MCPClient,
  McpToolAnnotations,
} from "@ai-sdk/mcp";
import { Experimental_StdioMCPTransport } from "@ai-sdk/mcp/mcp-stdio";
import { logger } from "@workspace/shared/logger";

import type { McpServerConfig } from "./config";

/** 一个 MCP 工具在模型眼里的样子：名字、说明、入参结构。 */
export type McpToolDefinition = {
  name: string;
  title?: string;
  description?: string;
  /** 服务器给的 JSON Schema，原样交给 AI SDK。 */
  inputSchema: Record<string, unknown>;
  annotations?: McpToolAnnotations;
};

/** 握手超时：一个连不上的服务器不该拖住整个回合。 */
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;

/** 列工具的最大翻页数，防止坏服务器把游标当无限流用。 */
const MAX_TOOL_PAGES = 20;

/** 远程传输的配置形状，与 SDK 的 `MCPTransportConfig` 一致。 */
type RemoteTransportConfig = {
  type: "http" | "sse";
  url: string;
  headers: Record<string, string>;
};

export type McpConnectionOptions = {
  connectTimeoutMs?: number;
};

/**
 * 一个 MCP 服务器的连接。
 *
 * 只做四件事：建立连接、列工具、调用工具、关闭。重连、空闲、引用计数都在
 * `McpManager` 里，这一层不关心别的会话。
 */
export class McpConnection {
  readonly #server: McpServerConfig;
  readonly #connectTimeoutMs: number;
  #client?: MCPClient;
  /** 正在进行的握手；并发的装配共用同一次，不要各拉一个子进程。 */
  #connecting?: Promise<MCPClient>;
  #tools?: readonly McpToolDefinition[];

  constructor(server: McpServerConfig, options: McpConnectionOptions = {}) {
    this.#server = server;
    this.#connectTimeoutMs =
      options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  }

  get connected(): boolean {
    return this.#client !== undefined;
  }

  /** 建连并完成握手；并发调用共用同一次握手。 */
  async connect(): Promise<void> {
    if (this.#client) {
      return;
    }

    this.#connecting ??= this.#open().finally(() => {
      this.#connecting = undefined;
    });

    this.#client = await this.#connecting;
  }

  async #open(): Promise<MCPClient> {
    return await createMCPClient({
      transport: this.#transport(),
      clientName: "aify-zero",
      version: "1.0.0",
      initializationOptions: { timeout: this.#connectTimeoutMs },
    });
  }

  /**
   * 列工具，按名字排序。
   *
   * 结果缓存在连接上：同一个会话里的多次装配不该让服务器被反复问一遍。
   */
  async listTools(): Promise<readonly McpToolDefinition[]> {
    if (this.#tools) {
      return this.#tools;
    }

    const client = await this.#requireClient();
    const tools: McpToolDefinition[] = [];
    let cursor: string | undefined;

    for (let page = 0; page < MAX_TOOL_PAGES; page += 1) {
      const result = await client.listTools({
        params: cursor === undefined ? undefined : { cursor },
      });

      for (const tool of result.tools) {
        tools.push({
          name: tool.name,
          title: tool.title,
          description: tool.description,
          inputSchema: tool.inputSchema as Record<string, unknown>,
          annotations: tool.annotations,
        });
      }

      cursor = result.nextCursor;
      if (cursor === undefined) {
        break;
      }
    }

    tools.sort((a, b) => a.name.localeCompare(b.name));
    this.#tools = tools;
    return tools;
  }

  /** 调用一个工具。失败由调用方转成工具错误，不在这一层抛给模型。 */
  async callTool(
    toolName: string,
    input: unknown,
    options: { abortSignal?: AbortSignal } = {}
  ): Promise<CallToolResult> {
    const client = await this.#requireClient();

    return await client.callTool({
      name: toolName,
      arguments: (input ?? {}) as Record<string, unknown>,
      options: { signal: options.abortSignal },
    });
  }

  /** 关闭连接。重复调用安全；失败只告警。 */
  async close(): Promise<void> {
    const client = this.#client;
    this.#client = undefined;
    this.#tools = undefined;

    if (!client) {
      return;
    }

    try {
      await client.close();
    } catch (error) {
      logger.warn(`[mcp] failed to close server "${this.#server.name}"`, error);
    }
  }

  async #requireClient(): Promise<MCPClient> {
    await this.connect();
    // connect 保证 client 已赋值；这里再取一次是为了让类型收窄。
    const client = this.#client;
    if (!client) {
      throw new Error(`MCP server "${this.#server.name}" is not connected`);
    }
    return client;
  }

  #transport(): RemoteTransportConfig | Experimental_StdioMCPTransport {
    const { transport } = this.#server;

    if (transport.type === "stdio") {
      return new Experimental_StdioMCPTransport({
        command: transport.command,
        args: transport.args,
        env: transport.env,
        cwd: transport.cwd,
      });
    }

    return {
      type: transport.type,
      url: transport.url,
      headers: transport.headers,
    };
  }
}
