import type { CatalogEntry } from "../../tool-catalog/catalog";
import {
  CALL_TOOL_NAME,
  createCallTool,
  resolveCatalogCall,
} from "../../tools/call-tool";
import { createSearchToolsTool } from "../../tools/search-tools";
import type { CatalogUnavailable } from "../capabilities";
import { Capabilities } from "../capabilities";
import type { ExtensionAPI, ExtensionOptions } from "../types";
import { Extension } from "../types";

/** 提示片段里最多列几个服务器。 */
const MAX_LISTED_SERVERS = 20;

export type ToolCatalogExtensionOptions = ExtensionOptions & {
  /** 当前目录里的条目，每次调用现读：工具是装配期陆续注册的。 */
  entries(): CatalogEntry[];
};

/**
 * 工具目录扩展。
 *
 * 它注册两个常驻工具——搜索与转调——和一段提示片段。目录本身不在这里：
 * 目录就是「被注册成 `deferred` 的那些工具」，由 `entries` 现算。
 */
export class ToolCatalogExtension extends Extension {
  readonly #entries: () => CatalogEntry[];

  constructor(options: ToolCatalogExtensionOptions) {
    super(options);
    // 包一层：调用方的函数可能带 `this`，交给它自己决定怎么用。
    this.#entries = () => options.entries();
  }

  init(api: ExtensionAPI): void {
    // 没有 MCP 扩展时这个能力不存在，那是「没有服务器可漏」，不是错误。
    const unavailable = (): readonly CatalogUnavailable[] =>
      api.optional(Capabilities.catalogUnavailable)?.() ?? [];

    api.tool(
      "search-tools",
      createSearchToolsTool({ entries: this.#entries, unavailable })
    );
    // 执行层不认名字，只问这个工具怎么解析：转调挂在工具上，跟着工具集走。
    api.tool(CALL_TOOL_NAME, createCallTool(), {
      resolveCall: resolveCatalogCall,
    });

    api.instructionsSection({
      id: "tool-catalog",
      // 排在资源类片段之后：它讲的是这一轮有哪些工具可搜，不是项目背景。
      priority: 50,
      render: (prompt) => prompt + renderSection(this.#entries()),
    });
  }
}

/**
 * 告诉模型「有目录可搜」的那一段。
 *
 * 只给服务器名和工具数。列出工具名会让这段随目录增长，而那正是这个方案要
 * 去掉的成本。
 */
function renderSection(entries: readonly CatalogEntry[]): string {
  if (entries.length === 0) {
    return "";
  }

  const counts = new Map<string, number>();
  for (const entry of entries) {
    const server = entry.namespace ?? "";
    counts.set(server, (counts.get(server) ?? 0) + 1);
  }

  const servers = [...counts.entries()].toSorted(([a], [b]) =>
    a.localeCompare(b)
  );
  const shown = servers.slice(0, MAX_LISTED_SERVERS);
  const hidden = servers.length - shown.length;

  const lines = shown.map(
    ([server, count]) =>
      `- ${server || "other"} (${count} ${count === 1 ? "tool" : "tools"})`
  );

  if (hidden > 0) {
    lines.push(`- and ${hidden} more ${hidden === 1 ? "server" : "servers"}`);
  }

  return [
    "",
    "",
    "## Tool catalog",
    "",
    "Some tools are not in your list. They belong to these servers.",
    "Before you say you have no tool for a task, search with search-tools. Then call the tool with call-tool({ name, input }).",
    "",
    ...lines,
  ].join("\n");
}
