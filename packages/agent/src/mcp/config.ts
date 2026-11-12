import { z } from "zod";

import type { ToolExposure } from "../types";

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

/**
 * 授权方式。
 *
 * `headers` 表示用 `transport.headers` 里的静态凭据；`oauth` 表示走授权流程。
 * 字段可省略：旧设置里没有它，读的时候按 headers 是否为空推断，不用迁移数据。
 */
export const mcpAuthSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("none") }).strict(),
  z.object({ type: z.literal("headers") }).strict(),
  z.object({ type: z.literal("oauth") }).strict(),
]);

export type McpAuth = z.infer<typeof mcpAuthSchema>;

export const mcpServerSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().refine(isValidMcpServerName, MCP_SERVER_NAME_MESSAGE),
    enabled: z.boolean().default(true),
    /** 放行没有只说读的工具；破坏性注解仍然询问。 */
    autoApprove: z.boolean().default(false),
    /**
     * 这些工具是否随每一步请求声明给模型。
     *
     * 字段可省略：旧设置里没有它，读的时候按 `deferred` 推断，不用迁移数据。
     * 补默认值放在 {@link mcpExposureType}，和 `auth` 同一套做法。
     */
    exposure: z.enum(["direct", "deferred"]).optional(),
    auth: mcpAuthSchema.optional(),
    transport: z.discriminatedUnion("type", [
      mcpStdioTransportSchema,
      mcpRemoteTransportSchema,
    ]),
  })
  .strict()
  .superRefine((server, ctx) => {
    // stdio 的凭据来自它自己的环境变量，这里插不进授权流程。
    if (server.auth?.type === "oauth" && server.transport.type === "stdio") {
      ctx.addIssue({
        code: "custom",
        message: "OAuth needs an http or sse transport",
        path: ["auth"],
      });
    }
  });

export type McpServerConfig = z.infer<typeof mcpServerSchema>;
export type McpServerTransport = McpServerConfig["transport"];

/**
 * 一份配置实际用的是哪一档授权。
 *
 * 缺省值从 `transport.headers` 推：旧设置只写过请求头，没有 `auth` 字段，
 * 读出来必须仍然是「静态凭据」，不能当成不需要授权。
 */
export function mcpAuthType(server: McpServerConfig): McpAuth["type"] {
  if (server.auth) {
    return server.auth.type;
  }

  return server.transport.type !== "stdio" &&
    Object.keys(server.transport.headers).length > 0
    ? "headers"
    : "none";
}

/** 这个服务器是否需要走授权流程。 */
export function needsMcpAuthorization(server: McpServerConfig): boolean {
  return (
    mcpAuthType(server) === "oauth" &&
    server.transport.type !== "stdio" &&
    server.enabled
  );
}

/**
 * 这台服务器的工具是否声明给模型。
 *
 * 缺省 `deferred`：工具只进工具目录，模型搜到之后用转调调用它。改成 `direct`
 * 就是退回全量声明，适合工具少又天天要用的服务器。
 */
export function mcpExposureType(server: McpServerConfig): ToolExposure {
  return server.exposure ?? "deferred";
}

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

/** 一条配置与同组其它配置冲突的地方。字符集与空命令由 schema 管，这里只管跨条目。 */
export type McpServerProblem =
  | { kind: "duplicate-id"; id: string }
  | { kind: "duplicate-name"; name: string };

/**
 * 配置之间的一致性检查。
 *
 * 服务器名是工具名前缀，重名会让两个服务器的工具互相覆盖，因此在保存前就
 * 拦住，而不是等到注册时才发现。id 重复会让两个条目争同一个连接槽。
 */
export function findMcpServerProblems(
  servers: readonly McpServerConfig[]
): McpServerProblem[] {
  const problems: McpServerProblem[] = [];
  const seenIds = new Set<string>();
  const seenNames = new Set<string>();

  for (const server of servers) {
    if (seenIds.has(server.id)) {
      problems.push({ kind: "duplicate-id", id: server.id });
    }
    seenIds.add(server.id);

    if (seenNames.has(server.name)) {
      problems.push({ kind: "duplicate-name", name: server.name });
    }
    seenNames.add(server.name);
  }

  return problems;
}
