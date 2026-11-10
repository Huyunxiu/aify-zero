import { createMCPClient, UnauthorizedError } from "@ai-sdk/mcp";
import type {
  CallToolResult,
  MCPClient,
  McpToolAnnotations,
  OAuthClientProvider,
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
  authProvider?: OAuthClientProvider;
  /** 只读令牌那一档用它注入 Authorization，不走 SDK 的 401 流程。 */
  fetch?: typeof fetch;
};

/** 带授权地址的 provider：管理器在 401 之后把它交给界面。 */
export type McpAuthProvider = OAuthClientProvider & {
  readonly authorizationUrl?: URL;
};

export type McpAuthorizationMode =
  /** 撞到 401 就发起授权，用户点「授权」走这一档。 */
  | "start"
  /** 只带已存令牌，401 就报错；「测试连接」走这一档，不会注册新客户端。 */
  | "reuse";

export type McpConnectionOptions = {
  connectTimeoutMs?: number;
  /** 远程服务器走授权流程时由宿主注入；stdio 没有。 */
  authProvider?: McpAuthProvider;
  /** 默认 `start`：可以由这次连接发起授权。 */
  authorization?: McpAuthorizationMode;
};

/**
 * 这次失败是不是「需要用户授权」。
 *
 * 有 provider 时 SDK 抛 `UnauthorizedError`；没 provider 或重试过一次之后
 * 走的是带 `statusCode` 的 `MCPClientError`。两种都要认，否则一次 401 会被
 * 记成普通的连接失败，用户永远看不到「去授权」的提示。
 */
export function isAuthorizationRequiredError(error: unknown): boolean {
  if (error instanceof UnauthorizedError) {
    return true;
  }

  if (typeof error !== "object" || error === null) {
    return false;
  }

  const record = error as { name?: unknown; statusCode?: unknown };

  return record.name === "UnauthorizedError" || record.statusCode === 401;
}

/**
 * 一个 MCP 服务器的连接。
 *
 * 只做四件事：建立连接、列工具、调用工具、关闭。重连、空闲、引用计数都在
 * `McpManager` 里，这一层不关心别的会话。
 */
export class McpConnection {
  readonly #server: McpServerConfig;
  readonly #connectTimeoutMs: number;
  readonly #authProvider?: McpAuthProvider;
  readonly #authorization: McpAuthorizationMode;
  #client?: MCPClient;
  /** 正在进行的握手；并发的装配共用同一次，不要各拉一个子进程。 */
  #connecting?: Promise<MCPClient>;
  #tools?: readonly McpToolDefinition[];

  constructor(server: McpServerConfig, options: McpConnectionOptions = {}) {
    this.#server = server;
    this.#connectTimeoutMs =
      options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.#authProvider = options.authProvider;
    this.#authorization = options.authorization ?? "start";
  }

  /** 授权流程捕获到的地址；401 之后管理器读它。 */
  authorizationUrl(): string | undefined {
    return this.#authProvider?.authorizationUrl?.toString();
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

  /**
   * 每次请求现读令牌的 fetch。
   *
   * 「测试连接」用它：有令牌就带上，没有就得到一次 401，而不是一次注册。
   */
  #tokenFetch(provider: McpAuthProvider): typeof fetch {
    return async (input, init) => {
      const tokens = await provider.tokens();
      const headers = new Headers(init?.headers);

      if (tokens?.access_token !== undefined) {
        headers.set("authorization", `Bearer ${tokens.access_token}`);
      }

      return await fetch(input, { ...init, headers });
    };
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

    if (this.#authProvider === undefined) {
      return {
        type: transport.type,
        url: transport.url,
        headers: transport.headers,
      };
    }

    if (this.#authorization === "reuse") {
      // 只读这一档不走 SDK 的 401 流程：那条路会注册客户端、覆盖 verifier。
      return {
        type: transport.type,
        url: transport.url,
        headers: transport.headers,
        fetch: this.#tokenFetch(this.#authProvider),
      };
    }

    return {
      type: transport.type,
      url: transport.url,
      headers: transport.headers,
      authProvider: this.#authProvider,
    };
  }
}
