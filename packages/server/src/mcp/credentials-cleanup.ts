import { mcpAuthType } from "@workspace/agent";
import type { McpServerConfig } from "@workspace/agent";

import { clearMcpCredentials } from "./credentials";

/**
 * 丢掉那些已经对不上新配置的授权凭据。
 *
 * 令牌是按「哪个资源地址、哪一档授权」签发的：地址换了继续用等于把 A 的
 * 令牌发给 B。这里在保存设置之后跑一遍，返回被清掉的服务器 id，调用方顺带
 * 作废它们待完成的授权流程。
 *
 * 授权服务器的 issuer 变化在这里看不到——那是授权时才知道的，SDK 会用 pin
 * 比对并抛 `AuthorizationServerMismatchError`，最终的清理走同一条路。
 */
export function keepsMcpCredentials(
  previous: McpServerConfig,
  next?: McpServerConfig
): boolean {
  if (next === undefined || mcpAuthType(next) !== "oauth") {
    // 服务器删了，或者切回了静态凭据：存下的令牌没有用处。
    return false;
  }

  if (
    previous.transport.type !== next.transport.type ||
    previous.transport.type === "stdio" ||
    next.transport.type === "stdio"
  ) {
    // stdio 没有授权凭据；远程的同一条地址才算同一个资源。
    return false;
  }

  return previous.transport.url === next.transport.url;
}

export async function dropStaleMcpCredentials(
  before: readonly McpServerConfig[],
  after: readonly McpServerConfig[]
): Promise<string[]> {
  const nextById = new Map(after.map((server) => [server.id, server]));
  const dropped: string[] = [];

  for (const previous of before) {
    if (keepsMcpCredentials(previous, nextById.get(previous.id))) {
      continue;
    }

    await clearMcpCredentials(previous.id);
    dropped.push(previous.id);
  }

  return dropped;
}
