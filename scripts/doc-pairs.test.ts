import { describe, expect, test } from "vitest";

import { findProblems, readManifest } from "./doc-pairs.js";

const problemsFor = (files: string[], manifest: string[] = []) =>
  findProblems({ files, manifest });

describe(findProblems, () => {
  test("a document without a copy is a problem", () => {
    expect(problemsFor(["docs/plan.md"])).toStrictEqual([
      { file: "docs/plan.md", reason: "missing copy" },
    ]);
  });

  test("a document with a copy passes", () => {
    expect(problemsFor(["docs/plan.md", "docs/plan.zh.md"])).toStrictEqual([]);
  });

  test("a copy without its document is a problem", () => {
    expect(problemsFor(["docs/plan.zh.md"])).toStrictEqual([
      { file: "docs/plan.zh.md", reason: "copy without a document" },
    ]);
  });

  test("a document in the manifest may stay without a copy", () => {
    expect(problemsFor(["docs/plan.md"], ["docs/plan.md"])).toStrictEqual([]);
  });

  test("a manifest entry that has a copy must be deleted", () => {
    expect(
      problemsFor(["docs/plan.md", "docs/plan.zh.md"], ["docs/plan.md"])
    ).toStrictEqual([
      {
        file: "docs/plan.md",
        reason: "has a copy; delete the manifest entry",
      },
    ]);
  });

  test("a manifest entry without a document is a problem", () => {
    expect(problemsFor([], ["docs/gone.md"])).toStrictEqual([
      { file: "docs/gone.md", reason: "manifest entry has no document" },
    ]);
  });

  test("a manifest entry that is a copy is a problem", () => {
    expect(problemsFor(["docs/plan.zh.md"], ["docs/plan.zh.md"])).toStrictEqual(
      [
        { file: "docs/plan.zh.md", reason: "copy without a document" },
        { file: "docs/plan.zh.md", reason: "manifest entry is a copy" },
      ]
    );
  });

  test("installed skills and the links to AGENTS.md are outside the rule", () => {
    expect(
      problemsFor([
        ".agents/skills/hono/SKILL.md",
        "CLAUDE.md",
        ".github/copilot-instructions.md",
      ])
    ).toStrictEqual([]);
  });
});

describe(readManifest, () => {
  test("reads the documents list", () => {
    expect(readManifest('{"documents":["docs/plan.md"]}')).toStrictEqual([
      "docs/plan.md",
    ]);
  });

  test("rejects a list that holds something else", () => {
    expect(() => readManifest('{"documents":[1]}')).toThrow(
      "the manifest needs a documents list of paths"
    );
  });
});
