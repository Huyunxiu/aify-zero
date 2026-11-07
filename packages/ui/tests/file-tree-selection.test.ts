import { FileTree } from "@pierre/trees";
import { describe, expect, test } from "vitest";

import { selectOnlyPath } from "../src/elements/session-panel/file-tree-selection";

/** 一棵只有目录结构的小树；不需要 DOM，模型本身就能算选择。 */
function makeTree(): FileTree {
  return new FileTree({
    paths: ["a.ts", "b.ts", "dir/c.ts"],
    density: "default",
    icons: "complete",
    initialExpansion: "closed",
  });
}

describe("file tree selection", () => {
  test("jumping to another file leaves one selected row", () => {
    const model = makeTree();

    selectOnlyPath(model, "a.ts");
    selectOnlyPath(model, "b.ts");

    expect(model.getSelectedPaths()).toStrictEqual(["b.ts"]);
    model.cleanUp();
  });

  test("jumping to a directory drops the file selected before it", () => {
    const model = makeTree();

    selectOnlyPath(model, "a.ts");
    selectOnlyPath(model, "dir/");

    expect(model.getSelectedPaths()).toStrictEqual(["dir/"]);
    model.cleanUp();
  });

  test("re-selecting the same path keeps one row", () => {
    const model = makeTree();

    selectOnlyPath(model, "a.ts");
    selectOnlyPath(model, "a.ts");

    expect(model.getSelectedPaths()).toStrictEqual(["a.ts"]);
    model.cleanUp();
  });
});
