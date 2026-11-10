import type { McpServerConfig } from "@workspace/agent";
import { McpAuthorizationFlows, McpOAuthProvider } from "@workspace/agent";
import { logger } from "@workspace/shared/logger";

import { mcpCredentialStore } from "./credentials";

/**
 * 授权回调的地址。
 *
 * 端口可能在 listen 之后才知道（`AIFY_API_PORT=0`），所以先留空，由
 * `startServer` 在拿到真实端口后写入。没写之前 `oauth` 配置会退回失败，
 * 而不是带着一个假地址去注册客户端。
 */
let redirectUrl: string | undefined;

/** 待完成的授权流程；回环回调靠它把 `state` 换回服务器 id。 */
export const mcpAuthorizationFlows = new McpAuthorizationFlows();

export function setMcpOAuthRedirectUrl(value: string): void {
  redirectUrl = value;
}

/**
 * 按配置决定要不要给这个服务器一个 provider。
 *
 * 非 `oauth`、stdio、或者还不知道回环地址时返回 undefined：管理器据此退化成
 * 普通连接，不会误发一个没有回调地址的注册请求。
 */
export function createMcpAuthProvider(
  server: McpServerConfig
): McpOAuthProvider | undefined {
  if (server.auth?.type !== "oauth" || server.transport.type === "stdio") {
    return undefined;
  }

  if (redirectUrl === undefined) {
    logger.warn(
      "[mcp] OAuth redirect URL is not set yet; authorization is unavailable"
    );
    return undefined;
  }

  return new McpOAuthProvider({
    serverId: server.id,
    store: mcpCredentialStore,
    redirectUrl,
    onState: (state) => {
      // 存快照：回调不读设置，只认这次发起时的配置。
      mcpAuthorizationFlows.register(state, server);
    },
  });
}
