import { auth } from "@ai-sdk/mcp";
import type { OAuthClientProvider } from "@ai-sdk/mcp";

export type CompleteMcpAuthorizationOptions = {
  provider: OAuthClientProvider;
  serverUrl: string;
  code: string;
  state: string;
  /** 授权响应里的 `iss`；有就校验它是不是同一个授权服务器。 */
  issuer?: string;
};

/**
 * 用回环回调收到的授权码换令牌。
 *
 * 元数据发现、客户端信息、PKCE verifier 都在 `auth()` 里完成；这里只是把
 * 用户代理那边的结果交回去，并确认它真的走完了（而不是又要一次跳转）。
 */
export async function completeMcpAuthorization(
  options: CompleteMcpAuthorizationOptions
): Promise<void> {
  const result = await auth(options.provider, {
    serverUrl: options.serverUrl,
    authorizationCode: options.code,
    callbackState: options.state,
    ...(options.issuer === undefined ? {} : { callbackIssuer: options.issuer }),
  });

  if (result !== "AUTHORIZED") {
    throw new Error("MCP authorization did not complete");
  }
}
