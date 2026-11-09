import { z } from "zod";

/** 工具名前缀与工具名之间的分隔符。 */
const MCP_TOOL_NAME_SEPARATOR = "__";

/** 服务器名的字符集：工具名前缀只允许这一段安全的字符。 */
const MCP_SERVER_NAME_CHARS = /^[a-z0-9][a-z0-9_-]{0,31}$/;

const MCP_SERVER_NAME_MESSAGE =
  "Use lowercase letters, digits, _ and -; start with a letter or digit";

/**
 * 服务器名会变成工具名前缀，所以必须能和分隔符 `__` 分开。
 *
 * 光看字符集不够：`ab__cd` 允许通过，它的工具 `t` 会叫 `ab__cd__t`，而切分
 * 只认第一个 `__`，服务器名就成了 `ab`，审批查不到注解。结尾下划线同理，
 * 会与分隔符连成 `___`。
 */
export function isValidMcpServerName(name: string): boolean {
  if (!MCP_SERVER_NAME_CHARS.test(name)) {
    return false;
  }

  return !name.includes(MCP_TOOL_NAME_SEPARATOR) && !name.endsWith("_");
}

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
    name: z.string().refine(isValidMcpServerName, MCP_SERVER_NAME_MESSAGE),
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
