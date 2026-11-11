import type { Tool } from "ai";
import { describe, expect, test } from "vitest";

import { ToolCatalogExtension } from "../../src/extensions/builtin/tool-catalog.js";
import type {
  ExtensionAPI,
  InstructionsSection,
} from "../../src/extensions/types.js";
import type { CatalogEntry } from "../../src/tool-catalog/catalog.js";
import type { resolveCatalogCall } from "../../src/tools/call-tool.js";

const entryParser = (name: string, description: string): CatalogEntry => {
  const at = name.indexOf("__");

  return {
    name,
    namespace: at > 0 ? name.slice(0, at) : undefined,
    description,
    signature: "{ query: string }",
  };
};

const entries: CatalogEntry[] = [
  entryParser("linear__list_issues", "List issues in a Linear project."),
  entryParser("linear__create_issue", "Create a Linear issue."),
  entryParser("notion__search", "Search Notion."),
];

function createApi() {
  const tools = new Map<string, Tool>();
  const sections: InstructionsSection[] = [];
  const capabilities = new Map<string, unknown>();
  const route = new Map<string, unknown>();

  const api = {
    agent: {
      name: "main",
      sessionId: "s1",
      projectDirs: ["/tmp"],
      sessionDir: "/tmp/s1",
    },
    environment: {
      sessionId: "s1",
      projectDirs: ["/tmp"],
      primaryProjectDir: "/tmp",
      sessionDir: "/tmp/s1",
    },
    tool: (name: string, tool: Tool, options?: { resolveCall?: unknown }) => {
      tools.set(name, tool);
      if (options?.resolveCall) {
        route.set(name, options.resolveCall);
      }
    },
    provide: (token: { id: string }, value: unknown) => {
      capabilities.set(token.id, value);
    },
    optional: (token: { id: string }) => capabilities.get(token.id),
    use: () => {
      throw new Error("the catalog does not require any capability");
    },
    instructionsSection: (section: InstructionsSection) => {
      sections.push(section);
    },
    on: () => () => {},
    assembler: () => {},
  } as unknown as ExtensionAPI;

  return { api, tools, sections, capabilities, route };
}

function mount(
  unavailable: () => readonly { server: string; reason: string }[] = () => []
) {
  const harness = createApi();
  const extension = new ToolCatalogExtension({
    id: "tool-catalog",
    entries: () => entries,
  });

  extension.init(harness.api);

  // 目录扩展只读这个能力；没有 MCP 的会话不会有人提供它。
  if (unavailable) {
    harness.capabilities.set("catalogUnavailable", unavailable);
  }

  return harness;
}

const search = async (
  harness: ReturnType<typeof mount>,
  input: { query: string; limit?: number }
) => {
  const tool = harness.tools.get("search-tools");
  const result = (await tool?.execute?.(input, {} as never)) as {
    code: "ok";
    output: {
      results: { tool: string; description: string; signature: string }[];
      catalogSize: number;
      remaining: number;
      unavailable?: unknown[];
    };
  };

  // 调用方只看工具交回模型的那一段，不看 `code` 这层包装。
  return result.output;
};

describe(ToolCatalogExtension, () => {
  test("registers the search tool and the route tool", () => {
    const { tools } = mount();

    expect([...tools.keys()]).toStrictEqual(["search-tools", "call-tool"]);
  });

  test("answers a search with names, one line of text and a signature", async () => {
    const output = await search(mount(), { query: "linear" });

    expect(output.results).toStrictEqual([
      {
        tool: "linear__create_issue",
        description: "Create a Linear issue.",
        signature: "{ query: string }",
      },
      {
        tool: "linear__list_issues",
        description: "List issues in a Linear project.",
        signature: "{ query: string }",
      },
    ]);
    expect(output.catalogSize).toBe(3);
    expect(output.remaining).toBe(0);
  });

  test("counts the matches it did not return", async () => {
    const output = await search(mount(), { query: "linear", limit: 1 });

    expect(output.results).toHaveLength(1);
    expect(output.remaining).toBe(1);
  });

  test("answers a query that matches nothing with nothing", async () => {
    const output = await search(mount(), { query: "kubernetes" });

    expect(output.results).toStrictEqual([]);
    expect(output.remaining).toBe(0);
    expect(output.catalogSize).toBe(3);
  });

  test("keeps the unavailable field off a complete answer", async () => {
    await expect(
      search(mount(), { query: "linear" })
    ).resolves.not.toHaveProperty("unavailable");
  });

  test("names the servers it could not search", async () => {
    const output = await search(
      mount(() => [{ server: "notion", reason: "needs authorization" }]),
      { query: "linear" }
    );

    expect(output.unavailable).toStrictEqual([
      { server: "notion", reason: "needs authorization" },
    ]);
  });

  test("registers the resolver that turns a route into a real call", () => {
    const { route } = mount();
    const resolve = route.get("call-tool") as typeof resolveCatalogCall;

    expect(
      resolve({
        toolCallId: "call-1",
        toolName: "call-tool",
        input: { name: "linear__list_issues", input: { query: "open" } },
      })
    ).toStrictEqual({
      toolName: "linear__list_issues",
      input: { query: "open" },
    });

    // 其他工具原样执行；解析不了的输入留给 `call-tool` 自己解释。
    expect(
      resolve({ toolCallId: "call-2", toolName: "bash", input: {} })
    ).toBeUndefined();
    expect(
      resolve({ toolCallId: "call-3", toolName: "call-tool", input: {} })
    ).toBeUndefined();
  });

  test("tells the model the catalog exists, by server and count only", () => {
    const { sections } = mount();

    expect(sections).toHaveLength(1);
    expect(sections[0]?.render("base")).toBe(
      [
        "base",
        "",
        "## Tool catalog",
        "",
        "Some tools are not in your list. They belong to these servers.",
        "Before you say you have no tool for a task, search with search-tools. Then call the tool with call-tool({ name, input }).",
        "",
        "- linear (2 tools)",
        "- notion (1 tool)",
      ].join("\n")
    );
  });

  test("adds nothing when every tool is declared", () => {
    const harness = createApi();
    const extension = new ToolCatalogExtension({
      id: "tool-catalog",
      entries: () => [],
    });

    extension.init(harness.api);

    expect(harness.sections[0]?.render("base")).toBe("base");
  });
});
