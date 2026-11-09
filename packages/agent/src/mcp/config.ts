import { z } from "zod";

/** 工具名前缀与工具名之间的分隔符。 */
const MCP_TOOL_NAME_SEPARATOR = "__";

/**
 * 服务器名会变成工具名前缀，所以只允许一段安全的字符。
 *
 * 模型看到的工具名因此总是可解析的：前缀不会和工具名里的下划线混淆，因为
 * 前缀本身不含连续下划线。
 */
const MCP_SERVER_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

const mcpStdioTransportSchema = z
  .object({
    type: z.literal("stdio"),
    command: z.string().min(1, "Command is required"),
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), z.string()).default({}),
    cwd: z.string().optional(),
  })
  .strict();

const mcpRemoteTransportSchema = z
  .object({
    type: z.enum(["http", "sse"]),
    url: z.url(),
    headers: z.record(z.string(), z.string()).default({}),
  })
  .strict();

export const mcpServerSchema = z
  .object({
    id: z.string().min(1),
    name: z
      .string()
      .regex(
        MCP_SERVER_NAME_PATTERN,
        "Use lowercase letters, digits, _ and -; start with a letter or digit"
      ),
    enabled: z.boolean().default(true),
    /** 放行没有只说读的工具；破坏性注解仍然询问。 */
    autoApprove: z.boolean().default(false),
    transport: z.discriminatedUnion("type", [
      mcpStdioTransportSchema,
      mcpRemoteTransportSchema,
    ]),
  })
  .strict();

export type McpServerConfig = z.infer<typeof mcpServerSchema>;
export type McpServerTransport = McpServerConfig["transport"];

/** 模型看到的工具名。 */
export function mcpToolName(serverName: string, toolName: string): string {
  return `${serverName}${MCP_TOOL_NAME_SEPARATOR}${toolName}`;
}

/**
 * 从工具名取回服务器名与工具名。
 *
 * 只按第一个分隔符切分：工具名自己带下划线不该影响前缀。
 */
export function splitMcpToolName(
  fullName: string
): { serverName: string; toolName: string } | undefined {
  const at = fullName.indexOf(MCP_TOOL_NAME_SEPARATOR);
  if (at <= 0) {
    return undefined;
  }

  const toolName = fullName.slice(at + MCP_TOOL_NAME_SEPARATOR.length);
  if (!toolName) {
    return undefined;
  }

  return { serverName: fullName.slice(0, at), toolName };
}

/**
 * 配置之间的一致性检查。
 *
 * 服务器名是工具名前缀，重名会让两个服务器的工具互相覆盖，因此在保存前就
 * 拦住，而不是等到注册时才发现。
 */
export function findMcpServerProblems(
  servers: readonly McpServerConfig[]
): string[] {
  const problems: string[] = [];
  const seenIds = new Set<string>();
  const seenNames = new Set<string>();

  for (const server of servers) {
    if (seenIds.has(server.id)) {
      problems.push(`duplicate server id: ${server.id}`);
    }
    seenIds.add(server.id);

    if (seenNames.has(server.name)) {
      problems.push(`duplicate server name: ${server.name}`);
    }
    seenNames.add(server.name);

    if (
      server.transport.type === "stdio" &&
      server.transport.command.trim() === ""
    ) {
      problems.push(`server "${server.name}" has an empty command`);
    }
  }

  return problems;
}
