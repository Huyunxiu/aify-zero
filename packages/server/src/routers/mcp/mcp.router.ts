import { mcpServerSchema } from "@workspace/agent/mcp/config";

import { publicProcedure } from "../../index";
import { getMcpManager } from "../../mcp/registry";
import { getUserSettings } from "../settings/settings.service";

/** 每个已配置服务器一行：状态、工具数、失败原因。 */
const statuses = publicProcedure
  .route({ method: "GET", path: "/mcp/servers/status" })
  .handler(async () => {
    const settings = await getUserSettings();
    return { data: getMcpManager().statuses(settings.mcpServers) };
  });

/** 试连一次，不改动已有连接；编辑弹窗用它。 */
const test = publicProcedure
  .route({ method: "POST", path: "/mcp/servers/test" })
  .input(mcpServerSchema)
  .handler(async ({ input }) => await getMcpManager().test(input));

export const mcp = { statuses, test };
