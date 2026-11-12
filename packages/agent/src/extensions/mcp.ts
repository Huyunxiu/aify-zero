import { getErrorMessage } from "@workspace/shared/errors";
import { logger } from "@workspace/shared/logger";

import { mcpExposureType, mcpToolName } from "../mcp/config";
import type { McpServerConfig } from "../mcp/config";
import type { McpLease, McpManager } from "../mcp/manager";
import { createMcpTool } from "../mcp/tool";
import type { CatalogUnavailable } from "./capabilities";
import { Capabilities } from "./capabilities";
import type { ExtensionAPI, ExtensionOptions } from "./types";
import { Extension } from "./types";

export interface McpExtensionOptions extends ExtensionOptions {
  /** 进程级连接管理器，由宿主持有。 */
  manager: McpManager;
  servers: readonly McpServerConfig[];
}

/**
 * MCP 扩展。
 *
 * 装配时向管理器借一份工具快照，把每个工具以前缀 `服务器名__工具名` 注册成
 * 本地工具。连不上的服务器跳过，不打断装配；会话结束时只归还租约，连接留给
 * 管理器按空闲时间收。
 *
 * 审批不在这里：见 `createMcpToolApprovalPattern` 的说明。
 */
export class McpExtension extends Extension {
  readonly #manager: McpManager;
  readonly #servers: readonly McpServerConfig[];
  #leases: McpLease[] = [];
  /** 这次装配没就绪的服务器，给工具目录的搜索结果用。 */
  #unavailable: CatalogUnavailable[] = [];

  constructor(options: McpExtensionOptions) {
    super(options);
    this.#manager = options.manager;
    this.#servers = options.servers;
  }

  async init(api: ExtensionAPI): Promise<void> {
    // 同一个实例被重复装配时，先还掉上一轮的引用，否则引用计数回不到 0。
    this.dispose();

    this.#unavailable = [];

    for (const server of this.#servers) {
      if (!server.enabled) {
        continue;
      }

      const lease = await this.#manager.acquire(server);
      this.#leases.push(lease);

      if (lease.status !== "ready") {
        // 「这台服务器上真的没有那个工具」和「这台服务器没连上」是两件事：
        // 后者要出现在搜索结果里，否则模型会一直换词重搜。
        this.#unavailable.push({
          server: server.name,
          reason:
            lease.status === "needs-auth"
              ? "needs authorization"
              : "failed to start",
        });
        continue;
      }

      for (const definition of lease.tools) {
        const name = mcpToolName(server.name, definition.name);
        try {
          api.tool(
            name,
            createMcpTool({
              server,
              definition,
              call: (input, options) =>
                lease.callTool(definition.name, input, options),
            }),
            { exposure: mcpExposureType(server) }
          );
        } catch (error) {
          // 一个服务器里的坏工具不该让整个会话装配失败。
          logger.warn(
            `[mcp] tool "${name}" was not registered: ${getErrorMessage(error)}`
          );
        }
      }
    }

    // 工具目录问的是「哪些服务器的工具不在里面」；只有这里知道答案。
    api.provide(Capabilities.catalogUnavailable, () => this.#unavailable);
  }

  dispose(): void {
    for (const lease of this.#leases) {
      lease.release();
    }
    this.#leases = [];
    this.#unavailable = [];
  }
}
