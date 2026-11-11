import { tool } from "ai";
import { z } from "zod";

import type { CatalogUnavailable } from "../extensions/capabilities";
import type { CatalogEntry } from "../tool-catalog/catalog";
import { searchCatalog } from "../tool-catalog/rank";
import type { ToolOutput } from "./types";

/** 一次搜索默认返回几条。 */
export const DEFAULT_SEARCH_LIMIT = 10;

/** 一次搜索最多返回几条：再多的结果也把省下的上下文花回去了。 */
export const MAX_SEARCH_LIMIT = 50;

/** 目录里的一条，按模型要读的样子给出。 */
export type SearchToolsResult = {
  tool: string;
  description: string;
  signature: string;
};

export type SearchToolsOutput = {
  results: SearchToolsResult[];
  /** 目录里一共有多少条工具。前缀查询也只扫一台服务器，所以它不是一个「查了几条」的数。 */
  catalogSize: number;
  /** 还有多少条命中超出 `limit`；为 0 表示查全了。 */
  remaining: number;
  /** 没被搜到的服务器。没有时字段不出现。 */
  unavailable?: CatalogUnavailable[];
};

/** 搜索需要读的两个来源，由扩展在装配时接进来。 */
export type ToolCatalogSource = {
  /** 当前目录里的全部条目，每次调用现读。 */
  entries(): CatalogEntry[];
  /** 装配时没就绪的服务器。 */
  unavailable(): readonly CatalogUnavailable[];
};

/**
 * 让模型去找一个它看不见的工具。
 *
 * 它搜的是这个 agent 自己的目录——注册成 `deferred` 的那些工具——回答里给准确
 * 名字、一行说明和参数签名。它从不返回完整 schema：省下来的上下文就是它存在
 * 的理由。
 */
function createSearchToolsTool(source: ToolCatalogSource) {
  return tool({
    description: [
      "Search the catalog for tools that are not in your list. For example, the tools of MCP servers.",
      "Use it when no tool in your list fits the request. It does not search the web.",
      "A result gives the exact name, one line of text, and the parameters. Call it with call-tool({ name, input }).",
      "catalogSize is the number of tools in the catalog. remaining is the number of matches that did not fit.",
      "Servers under unavailable were not searched. Do not search again for their tools.",
      'If you know the server, search "<server>__". This lists the tools of that server. It is faster.',
    ].join("\n"),
    inputSchema: z.object({
      query: z
        .string()
        .min(1)
        .describe(
          'Words describing the capability, such as "list open issues"; an exact tool name; or a server prefix such as "linear__".'
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(MAX_SEARCH_LIMIT)
        .optional()
        .describe(
          `Maximum number of results. Defaults to ${DEFAULT_SEARCH_LIMIT}.`
        ),
    }),
    execute: ({ query, limit }): ToolOutput<SearchToolsOutput> => {
      const entries = source.entries();
      const matched = searchCatalog(entries, query);
      const results = matched.slice(
        0,
        Math.min(limit ?? DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT)
      );
      const unavailable = source.unavailable();

      return {
        code: "ok",
        output: {
          results: results.map((entry) => ({
            tool: entry.name,
            description: entry.description,
            signature: entry.signature,
          })),
          catalogSize: entries.length,
          remaining: matched.length - results.length,
          ...(unavailable.length > 0 ? { unavailable: [...unavailable] } : {}),
        },
      };
    },
  });
}

type SearchToolsToolType = ReturnType<typeof createSearchToolsTool>;

export { createSearchToolsTool, type SearchToolsToolType };
