import type { McpServerConfig } from "@workspace/agent";
import { findMcpServerProblems } from "@workspace/agent/mcp/config";

import { ApiError } from "../errors";

/**
 * 拦下会互相覆盖的 MCP 配置。
 *
 * 服务器名是工具名前缀，重名会让两套工具互相覆盖；id 重名会让两个条目争同一个
 * 连接槽。等到装配时才发现就太晚了——工具已经注册，用户也以为保存成功——所以
 * 保存设置时先查一遍。
 */
export function assertUniqueMcpServers(
  servers: readonly McpServerConfig[]
): void {
  const [problem] = findMcpServerProblems(servers);
  if (!problem) {
    return;
  }

  throw new ApiError("MCP_SERVER_DUPLICATE", {
    data: {
      kind: problem.kind,
      value: problem.kind === "duplicate-id" ? problem.id : problem.name,
    },
  });
}
