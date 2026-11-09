import { McpManager } from "@workspace/agent";

/**
 * 进程级的 MCP 连接管理器。
 *
 * 它必须比任何一个会话活得久：会话每回合都会重新装配 agent，连接放在会话里
 * 就变成每回合重启一次子进程。见 docs/adr/0001。
 */
let manager: McpManager | undefined;

/** 拿单例，第一次调用时创建。 */
export function getMcpManager(): McpManager {
  manager ??= new McpManager();
  return manager;
}

/** 收掉所有 MCP 连接。进程退出时调用。 */
export async function shutdownMcp(): Promise<void> {
  const current = manager;
  manager = undefined;
  await current?.close();
}
