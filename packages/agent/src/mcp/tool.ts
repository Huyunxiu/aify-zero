import type { CallToolResult } from "@ai-sdk/mcp";
import { getErrorMessage } from "@workspace/shared/errors";
import { jsonSchema, tool } from "ai";
import type { Tool } from "ai";

import type { ToolOutput } from "../tools/types";
import { truncateContent } from "../utils/truncate";
import type { McpServerConfig } from "./config";
import type { McpToolDefinition } from "./connection";

/** 单次结果的上限（256 KB）：再大的内容留给面板，不塞进上下文。 */
const MAX_OUTPUT_BYTES = 256 * 1024;

export type McpContentPartSummary = {
  type: string;
  mimeType?: string;
  bytes?: number;
};

export type McpToolOutputMetadata = {
  serverName: string;
  toolName: string;
  isError: boolean;
  truncated: boolean;
  /** 没有交给模型的二进制部分，只留摘要。 */
  parts: McpContentPartSummary[];
};

type McpToolOutput = ToolOutput<string, McpToolOutputMetadata>;

/** base64 的字节数：按填充位扣掉，避免把 5 字节算成 6。 */
function base64ByteLength(value: string): number {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return Math.floor((value.length * 3) / 4) - padding;
}

/** 一行的占位说明，替代没有交给模型的二进制内容。 */
function describePart(part: Record<string, unknown>): {
  line?: string;
  summary: McpContentPartSummary;
} {
  const type = typeof part.type === "string" ? part.type : "unknown";
  const mimeType =
    typeof part.mimeType === "string" ? part.mimeType : undefined;
  const data = typeof part.data === "string" ? part.data : undefined;
  const bytes = data === undefined ? undefined : base64ByteLength(data);

  const size = bytes === undefined ? "" : `, ${bytes} bytes`;
  const mime = mimeType === undefined ? type : mimeType;

  return {
    line: `[${mime}${size}]`,
    summary: { type, mimeType, bytes },
  };
}

/** resource 内容里的文本可以直接给模型；blob 只留摘要。 */
function renderResource(resource: Record<string, unknown>): {
  lines: string[];
  summary: McpContentPartSummary;
} {
  const uri = typeof resource.uri === "string" ? resource.uri : "";
  const mimeType =
    typeof resource.mimeType === "string" ? resource.mimeType : undefined;

  if (typeof resource.text === "string") {
    return {
      lines: [`<resource uri="${uri}">`, resource.text, "</resource>"],
      summary: { type: "resource", mimeType },
    };
  }

  const blob = typeof resource.blob === "string" ? resource.blob : undefined;
  const bytes = blob === undefined ? undefined : base64ByteLength(blob);
  const size = bytes === undefined ? "" : `, ${bytes} bytes`;

  return {
    lines: [`[resource ${uri}${size}]`],
    summary: { type: "resource", mimeType, bytes },
  };
}

/**
 * 把 MCP 的结果折成一段给模型看的文本。
 *
 * text 与 structuredContent 原样保留；image、audio、blob 这类东西当前没有
 * 通道回灌模型，降级成一行说明，原文只留类型与大小。超过上限就截断，并告诉
 * 模型怎么缩小范围。
 */
function summarizeResult(
  result: CallToolResult,
  server: McpServerConfig,
  definition: McpToolDefinition
): McpToolOutput {
  const lines: string[] = [];
  const parts: McpContentPartSummary[] = [];

  const content = (result.content ?? []) as Record<string, unknown>[];

  for (const record of content) {
    if (record.type === "text" && typeof record.text === "string") {
      lines.push(record.text);
      parts.push({ type: "text" });
      continue;
    }

    if (record.type === "resource" && record.resource !== null) {
      const rendered = renderResource(
        record.resource as Record<string, unknown>
      );
      lines.push(...rendered.lines);
      parts.push(rendered.summary);
      continue;
    }

    const described = describePart(record);
    if (described.line !== undefined) {
      lines.push(described.line);
    }
    parts.push(described.summary);
  }

  const structured = result.structuredContent;
  if (structured !== undefined && structured !== null) {
    lines.push("Structured content:", JSON.stringify(structured, null, 2));
    parts.push({ type: "structured" });
  }

  const text = lines.length > 0 ? lines.join("\n") : "(empty result)";
  // 只按字节截断：行数上限由字节数自然约束（最坏情况每行 2 字节），
  // 再加一条行规则只会让提示说错原因。
  const truncated = truncateContent({
    content: text,
    maxBytes: MAX_OUTPUT_BYTES,
    maxLines: Number.POSITIVE_INFINITY,
    direction: "head",
  });
  const wasTruncated = truncated.truncatedByBytes || truncated.truncatedByLines;

  const output = wasTruncated
    ? `${truncated.lines.join("\n")}\n\n[Output truncated at ${MAX_OUTPUT_BYTES / 1024} KB. Narrow the request, or ask for fewer fields.]`
    : text;

  return {
    output,
    code: result.isError === true ? "error" : "ok",
    metadata: {
      serverName: server.name,
      toolName: definition.name,
      isError: result.isError === true,
      truncated: wasTruncated,
      parts,
    },
  };
}

export type CreateMcpToolOptions = {
  server: McpServerConfig;
  definition: McpToolDefinition;
  call: (
    input: unknown,
    options: { abortSignal?: AbortSignal }
  ) => Promise<CallToolResult>;
};

type JsonSchemaInput = Parameters<typeof jsonSchema>[0];

/**
 * 把一个 MCP 工具包成本地工具。
 *
 * 入参结构原样透传：校验交给 AI SDK，服务器那边也会再校验一次。执行走
 * `call`，由管理器负责连接，所以这里不持有任何连接状态。
 */
export function createMcpTool({
  server,
  definition,
  call,
}: CreateMcpToolOptions): Tool {
  const description =
    definition.description?.trim() ||
    `Tool "${definition.name}" from MCP server "${server.name}".`;

  return tool({
    description,
    inputSchema: jsonSchema(
      definition.inputSchema as unknown as JsonSchemaInput
    ),
    execute: async (input: unknown, { abortSignal }) => {
      try {
        const result = await call(input, { abortSignal });
        return summarizeResult(result, server, definition);
      } catch (error) {
        return {
          output: `MCP tool "${definition.name}" on server "${server.name}" failed: ${getErrorMessage(error)}`,
          code: "error",
          metadata: {
            serverName: server.name,
            toolName: definition.name,
            isError: true,
            truncated: false,
            parts: [],
          },
        } satisfies McpToolOutput;
      }
    },
    toModelOutput({ output }) {
      const result = output;
      return result.code === "error"
        ? { type: "error-text", value: result.output }
        : { type: "text", value: result.output };
    },
  });
}
