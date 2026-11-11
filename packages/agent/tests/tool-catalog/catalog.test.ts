import { jsonSchema, tool } from "ai";
import type { Tool, ToolSet } from "ai";
import { describe, expect, test } from "vitest";
import { z } from "zod";

import {
  catalogEntries,
  namespaceOf,
  renderSignature,
} from "../../src/tool-catalog/catalog.js";
import type { ToolExposure } from "../../src/types.js";

const makeTool = (description: string, inputSchema = z.object({})): Tool =>
  tool({ description, inputSchema, execute: () => "ok" });

describe(namespaceOf, () => {
  test("takes the part before the first separator", () => {
    expect(namespaceOf("linear__list_issues")).toBe("linear");
  });

  test("has no namespace without a separator", () => {
    expect(namespaceOf("read-file")).toBeUndefined();
  });
});

describe(renderSignature, () => {
  test("lists required and optional parameters", () => {
    const signature = renderSignature(
      makeTool(
        "x",
        z.object({ query: z.string(), limit: z.number().optional() })
      )
    );

    expect(signature).toBe("{ query: string, limit?: number }");
  });

  test("shows the values an enum accepts", () => {
    const signature = renderSignature(
      makeTool("x", z.object({ order: z.enum(["asc", "desc"]) }))
    );

    expect(signature).toBe("{ order: asc | desc }");
  });

  test("collapses a nested object to one word", () => {
    const signature = renderSignature(
      makeTool("x", z.object({ filter: z.object({ state: z.string() }) }))
    );

    expect(signature).toBe("{ filter: object }");
  });

  test("says nothing for a tool that takes no parameters", () => {
    expect(renderSignature(makeTool("x", z.object({})))).toBe("{}");
  });

  test("caps a signature that would be longer than the limit", () => {
    const many = Object.fromEntries(
      Array.from({ length: 40 }, (_, index) => [
        `parameter_${index}`,
        z.string(),
      ])
    );
    const signature = renderSignature(makeTool("x", z.object(many)));

    expect(signature).toHaveLength(400);
    expect(signature.endsWith("…")).toBeTruthy();
  });

  test("reads a plain JSON Schema too", () => {
    const signature = renderSignature(
      tool({
        description: "x",
        inputSchema: jsonSchema({
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
        }),
        execute: () => "ok",
      })
    );

    expect(signature).toBe("{ name: string }");
  });
});

describe(catalogEntries, () => {
  const tools: ToolSet = {
    "read-file": makeTool("Read a file."),
    linear__list_issues: makeTool("List issues in a Linear project.\nMore."),
    notion__search: makeTool("Search Notion."),
  };

  const exposure = new Map<string, ToolExposure>([
    ["read-file", "direct"],
    ["linear__list_issues", "deferred"],
    ["notion__search", "deferred"],
  ]);

  test("holds only the deferred tools", () => {
    expect(
      catalogEntries(tools, exposure).map((entry) => entry.name)
    ).toStrictEqual(["linear__list_issues", "notion__search"]);
  });

  test("keeps one line of the description and the signature", () => {
    const [entry] = catalogEntries(tools, exposure);

    expect(entry?.description).toBe("List issues in a Linear project.");
    expect(entry?.signature).toBe("{}");
    expect(entry?.namespace).toBe("linear");
  });

  test("holds nothing when every tool is declared", () => {
    expect(catalogEntries(tools, new Map())).toStrictEqual([]);
  });
});
