import { describe, expect, test } from "vitest";

import type { CatalogEntry } from "../../src/tool-catalog/catalog.js";
import { searchCatalog } from "../../src/tool-catalog/rank.js";

const entry = (
  name: string,
  description: string,
  namespace?: string
): CatalogEntry => ({ name, description, signature: "", namespace });

const names = (entries: CatalogEntry[]) => entries.map((one) => one.name);

const catalog: CatalogEntry[] = [
  entry("linear__list_issues", "List issues in a Linear project.", "linear"),
  entry("linear__create_issue", "Create a Linear issue.", "linear"),
  entry("linear__list_teams", "List Linear teams.", "linear"),
  entry("notion__list_pages", "List pages in Notion.", "notion"),
  entry("list-files", "List files in the project."),
];

describe(searchCatalog, () => {
  test("answers nothing to an empty query", () => {
    expect(searchCatalog(catalog, "   ")).toStrictEqual([]);
  });

  test("puts an exact name above everything else", () => {
    expect(names(searchCatalog(catalog, "list-files"))).toStrictEqual([
      "list-files",
    ]);
  });

  test("finds a tool by its bare name when the server is forgotten", () => {
    // `list_issues` 只有 linear 里那一个，所以它排第一，且不是靠名字前缀命中。
    expect(names(searchCatalog(catalog, "list_issues"))[0]).toBe(
      "linear__list_issues"
    );
  });

  test("does not treat a name without a namespace as a bare name", () => {
    // `read-file` 没有分隔符。曾经按 `slice(1)` 取「短名」，于是 `ead-file`
    // 走了第二档，排在真正以它作命名空间的那个工具前面。修好之后它只是一个
    // 关键词命中，排在命名空间档之后。
    const ranked = names(
      searchCatalog(
        [
          entry("read-file", "Read a file."),
          entry("ead-file__list", "List things.", "ead-file"),
        ],
        "ead-file"
      )
    );

    expect(ranked).toStrictEqual(["ead-file__list", "read-file"]);
  });

  test("ranks a namespace above a name prefix", () => {
    const ranked = names(searchCatalog(catalog, "linear"));

    // 三个 linear 工具由命名空间命中排在最前，`list-files` 只能靠关键词。
    expect(ranked.slice(0, 3).toSorted()).toStrictEqual([
      "linear__create_issue",
      "linear__list_issues",
      "linear__list_teams",
    ]);
  });

  test("ranks a name prefix above a keyword", () => {
    const ranked = names(searchCatalog(catalog, "list"));

    // `list-files` 以 list 开头，所以排在只是说明里带 list 的那几个前面。
    expect(ranked[0]).toBe("list-files");
    expect(ranked).toContain("notion__list_pages");
  });

  test("breaks a tie on the number of query words it covers", () => {
    const ranked = names(searchCatalog(catalog, "list notion"));

    expect(ranked[0]).toBe("notion__list_pages");
  });

  test("breaks a full tie on the name, so the answer repeats", () => {
    const twice = [
      searchCatalog(catalog, "list"),
      searchCatalog(catalog, "list"),
    ];

    expect(names(twice[0]!)).toStrictEqual(names(twice[1]!));
  });

  test("lists one namespace when the query is a namespace prefix", () => {
    expect(names(searchCatalog(catalog, "linear__"))).toStrictEqual([
      "linear__create_issue",
      "linear__list_issues",
      "linear__list_teams",
    ]);
  });

  test("drops an entry no word of the query reaches", () => {
    expect(names(searchCatalog(catalog, "kubernetes"))).toStrictEqual([]);
  });

  test("matches a query that is not split by spaces", () => {
    expect(names(searchCatalog(catalog, "创建"))).toStrictEqual([]);

    const chinese: CatalogEntry[] = [
      entry("notes__写笔记", "把一段文字写进笔记。", "notes"),
    ];

    // 中文查询没有空格，切词不能把它切碎。
    expect(names(searchCatalog(chinese, "笔记"))).toStrictEqual([
      "notes__写笔记",
    ]);
  });
});
