import type { McpServerConfig } from "@workspace/agent";
import { mcpServerSchema } from "@workspace/agent/mcp/config";
import { z } from "zod";

import { ApiError } from "../../errors";
import { publicProcedure } from "../../index";
import { clearMcpCredentials, hasMcpTokens } from "../../mcp/credentials";
import { mcpAuthorizationFlows } from "../../mcp/oauth";
import { getMcpManager } from "../../mcp/registry";
import { getUserSettings } from "../settings/settings.service";

/** 每个已配置服务器一行：状态、工具数、失败原因。 */
const statuses = publicProcedure
  .route({ method: "GET", path: "/mcp/servers/status" })
  .handler(async () => {
    const settings = await getUserSettings();
    const rows = getMcpManager().statuses(settings.mcpServers);

    // 状态来自连接，凭据来自表：撤销按钮只在真存过令牌时才出现。
    return await Promise.all(
      rows.map(async (row) => ({
        ...row,
        authorized: await hasMcpTokens(row.id),
      }))
    );
  });

/** 试连一次，不改动已有连接；编辑弹窗用它。 */
const test = publicProcedure
  .route({ method: "POST", path: "/mcp/servers/test" })
  .input(mcpServerSchema)
  .handler(async ({ input }) => await getMcpManager().test(input));

async function findServer(id: string): Promise<McpServerConfig> {
  const settings = await getUserSettings();
  const server = settings.mcpServers.find((row) => row.id === id);

  if (server === undefined) {
    throw new ApiError("MCP_SERVER_NOT_FOUND", { data: { id } });
  }

  return server;
}

/**
 * 发起授权。
 *
 * 管理器会建一次连；服务器要授权时它把授权地址交回来，由界面打开浏览器。
 * 已经授权过就直接返回 `ready`，界面不用区分「第一次」和「重连」。
 */
const authorize = publicProcedure
  .route({ method: "POST", path: "/mcp/servers/authorize" })
  .input(z.object({ id: z.string().min(1) }))
  .handler(async ({ input }) => {
    const server = await findServer(input.id);
    return await getMcpManager().authorize(server);
  });

/** 撤销授权：清掉凭据与待完成的流程，状态回到未连接。 */
const revoke = publicProcedure
  .route({ method: "POST", path: "/mcp/servers/revoke" })
  .input(z.object({ id: z.string().min(1) }))
  .handler(async ({ input }) => {
    const server = await findServer(input.id);

    await clearMcpCredentials(server.id);
    mcpAuthorizationFlows.forget(server.id);
    getMcpManager().invalidateServer(server.id, { resetStatus: true });

    return { ok: true };
  });

export const mcp = { authorize, revoke, statuses, test };
