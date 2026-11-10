import type {
  McpAuthProvider,
  McpAuthorizationFlows,
  McpAuthorizeResult,
  McpServerConfig,
} from "@workspace/agent";
import { completeMcpAuthorization } from "@workspace/agent";
import { getErrorMessage } from "@workspace/shared/errors";
import { logger } from "@workspace/shared/logger";

import { createMcpAuthProvider, mcpAuthorizationFlows } from "./oauth";
import { getMcpManager } from "./registry";

export type McpAuthorizationCallbackResult = {
  ok: boolean;
  message: string;
};

/** 回调要用的东西；默认取进程内单例，测试可以换掉。 */
export type McpAuthorizationCallbackDeps = {
  flows: Pick<McpAuthorizationFlows, "take">;
  createProvider: (server: McpServerConfig) => McpAuthProvider | undefined;
  complete: typeof completeMcpAuthorization;
  authorize: (server: McpServerConfig) => Promise<McpAuthorizeResult>;
};

/** 回调页要显示的文本。只来自这里，不来自请求。 */
const MESSAGES = {
  done: "Authorization complete. You can close this tab.",
  failed: "Authorization did not complete. Return to the app and try again.",
  expired: "This authorization request expired. Start it again from the app.",
  unsupported: "This MCP server does not use the authorization flow.",
} as const;

function defaultDeps(): McpAuthorizationCallbackDeps {
  return {
    flows: mcpAuthorizationFlows,
    createProvider: createMcpAuthProvider,
    complete: completeMcpAuthorization,
    authorize: async (server) => await getMcpManager().authorize(server),
  };
}

/**
 * 处理回环回调。
 *
 * 这条路由不带令牌，所以它只用 `state` 换回发起授权时留下的配置快照：
 * 不读设置、不返回错误详情、不把授权码写进日志。
 */
export async function handleMcpAuthorizationCallback(
  params: {
    code?: string;
    state?: string;
    issuer?: string;
  },
  deps: McpAuthorizationCallbackDeps = defaultDeps()
): Promise<McpAuthorizationCallbackResult> {
  const { code, state, issuer } = params;

  if (state === undefined || state === "") {
    return { ok: false, message: MESSAGES.expired };
  }

  const server = deps.flows.take(state);
  if (server === undefined) {
    return { ok: false, message: MESSAGES.expired };
  }

  if (code === undefined || code === "") {
    // 用户拒绝授权时授权服务器会带 `error` 回来，没有 `code`。
    return { ok: false, message: MESSAGES.failed };
  }

  if (server.transport.type === "stdio") {
    return { ok: false, message: MESSAGES.unsupported };
  }

  try {
    const provider = deps.createProvider(server);
    if (provider === undefined) {
      return { ok: false, message: MESSAGES.unsupported };
    }

    await deps.complete({
      provider,
      serverUrl: server.transport.url,
      code,
      state,
      issuer,
    });

    // 令牌已落库：立刻连一次，设置页当场看到「已连接」。
    const result = await deps.authorize(server);
    return result.status === "ready"
      ? { ok: true, message: MESSAGES.done }
      : { ok: false, message: MESSAGES.failed };
  } catch (error) {
    logger.warn(
      `[mcp] authorization callback failed: ${getErrorMessage(error)}`
    );
    return { ok: false, message: MESSAGES.failed };
  }
}

/** 回调页：一段静态文本，不渲染任何来自请求的内容。 */
export function renderMcpAuthorizationPage(
  result: McpAuthorizationCallbackResult
): string {
  const color = result.ok ? "#0f766e" : "#b91c1c";
  const title = result.ok ? "Authorized" : "Not authorized";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · Aify Zero</title>
<style>
  html, body { height: 100%; margin: 0; }
  body {
    display: grid; place-items: center;
    background: #0b0b0c; color: #e7e7e8;
    font: 15px/1.6 ui-sans-serif, system-ui, -apple-system, sans-serif;
  }
  main { max-width: 32rem; padding: 2rem; text-align: center; }
  h1 { margin: 0 0 .75rem; font-size: 1.125rem; color: ${color}; }
  p { margin: 0; color: #a1a1aa; }
</style>
</head>
<body>
<main>
  <h1>${title}</h1>
  <p>${result.message}</p>
</main>
</body>
</html>`;
}
