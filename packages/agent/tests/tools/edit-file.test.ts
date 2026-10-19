import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { AgentContext } from "../../src/agent-context.js";
import { createEditFileTool } from "../../src/tools/edit-file.js";

type Edit = { oldText: string; newText: string };

/** 工具输出的最小形状；metadata 里的 diff 是这里重点验证的字段。 */
type EditResult = {
  output: string;
  code: "ok" | "error";
  metadata?: {
    filepath: string;
    replacements: number;
    linesAdded: number;
    linesRemoved: number;
    diff: string;
    firstChangedLine?: number;
  };
};

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "aify-edit-file-"));
  tempDirs.push(dir);
  return dir;
}

let workdir: string;
let agentContext: AgentContext;
let editTool: ReturnType<typeof createEditFileTool>;

function runEdit(
  input: { path: string; edits: Edit[] },
  abortSignal?: AbortSignal
): Promise<EditResult> {
  return editTool.execute(input, {
    toolCallId: "test-call",
    messages: [],
    context: agentContext,
    abortSignal,
  }) as unknown as Promise<EditResult>;
}

describe("edit-file tool", () => {
  beforeEach(async () => {
    workdir = await createTempDir();
    agentContext = { workdir } as AgentContext;
    editTool = createEditFileTool({ agentContext });
  });

  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
    );
  });

  test("applies several disjoint edits and reports the real diff", async () => {
    const filePath = join(workdir, "disjoint.txt");
    await writeFile(filePath, "one\ntwo\nthree\n", "utf-8");

    const result = await runEdit({
      path: "disjoint.txt",
      edits: [
        { oldText: "one", newText: "ONE" },
        { oldText: "three", newText: "THREE" },
      ],
    });

    expect(result.code).toBe("ok");
    expect(result.output).toBe(
      `Successfully replaced 2 blocks in ${filePath}.`
    );
    expect(result.metadata).toMatchObject({
      filepath: filePath,
      replacements: 2,
      linesAdded: 2,
      linesRemoved: 2,
      firstChangedLine: 1,
    });
    // diff 展示的是实际写入的内容，未改动的行作为上下文保留。
    expect(result.metadata?.diff).toBe(
      "-1 one\n+1 ONE\n 2 two\n-3 three\n+3 THREE"
    );
    await expect(readFile(filePath, "utf-8")).resolves.toBe(
      "ONE\ntwo\nTHREE\n"
    );
  });

  test("matches every edit against the original file", async () => {
    const filePath = join(workdir, "original.txt");
    await writeFile(filePath, "foo bar", "utf-8");

    const result = await runEdit({
      path: filePath,
      edits: [
        { oldText: "foo", newText: "bar" },
        { oldText: "bar", newText: "baz" },
      ],
    });

    expect(result.code).toBe("ok");
    await expect(readFile(filePath, "utf-8")).resolves.toBe("bar baz");
  });

  test("rejects an oldText that appears more than once", async () => {
    const filePath = join(workdir, "duplicate.txt");
    await writeFile(filePath, "same\nsame\n", "utf-8");

    const result = await runEdit({
      path: filePath,
      edits: [{ oldText: "same", newText: "other" }],
    });

    expect(result.code).toBe("error");
    expect(result.output).toMatch(/Found 2 occurrences/);
    await expect(readFile(filePath, "utf-8")).resolves.toBe("same\nsame\n");
  });

  test("rejects overlapping edits", async () => {
    const filePath = join(workdir, "overlap.txt");
    await writeFile(filePath, "abcdef", "utf-8");

    const result = await runEdit({
      path: filePath,
      edits: [
        { oldText: "abcd", newText: "x" },
        { oldText: "cdef", newText: "y" },
      ],
    });

    expect(result.code).toBe("error");
    expect(result.output).toMatch(/overlap/);
    await expect(readFile(filePath, "utf-8")).resolves.toBe("abcdef");
  });

  test("rejects an empty oldText", async () => {
    const filePath = join(workdir, "empty.txt");
    await writeFile(filePath, "content", "utf-8");

    const result = await runEdit({
      path: filePath,
      edits: [{ oldText: "", newText: "x" }],
    });

    expect(result.code).toBe("error");
    expect(result.output).toMatch(/must not be empty/);
  });

  test("rejects an edit that changes nothing", async () => {
    const filePath = join(workdir, "no-change.txt");
    await writeFile(filePath, "content", "utf-8");

    const result = await runEdit({
      path: filePath,
      edits: [{ oldText: "content", newText: "content" }],
    });

    expect(result.code).toBe("error");
    expect(result.output).toMatch(/No changes made/);
  });

  test("reports ENOENT instead of throwing when the file is missing", async () => {
    const result = await runEdit({
      path: "missing.txt",
      edits: [{ oldText: "a", newText: "b" }],
    });

    expect(result.code).toBe("error");
    expect(result.output).toContain(
      "Could not edit file: missing.txt. Error code: ENOENT."
    );
  });

  test("refuses to edit a binary file", async () => {
    const filePath = join(workdir, "binary.bin");
    const bytes = Buffer.from([0x61, 0x00, 0x62]);
    await writeFile(filePath, bytes);

    const result = await runEdit({
      path: filePath,
      edits: [{ oldText: "a", newText: "b" }],
    });

    expect(result.code).toBe("error");
    expect(result.output).toMatch(/Cannot edit binary files/);
    await expect(readFile(filePath)).resolves.toStrictEqual(bytes);
  });

  test("preserves a leading BOM and CRLF line endings", async () => {
    const filePath = join(workdir, "crlf.txt");
    const bom = String.fromCodePoint(0xfe_ff);
    await writeFile(filePath, `${bom}alpha\r\nbeta\r\n`, "utf-8");

    const result = await runEdit({
      path: filePath,
      edits: [{ oldText: "alpha", newText: "ALPHA" }],
    });

    expect(result.code).toBe("ok");
    await expect(readFile(filePath, "utf-8")).resolves.toBe(
      `${bom}ALPHA\r\nbeta\r\n`
    );
  });

  test("fuzzy-matches smart quotes without touching unchanged lines", async () => {
    const filePath = join(workdir, "fuzzy.txt");
    await writeFile(filePath, "const x = “hi”;   \nconst y = 1;   \n", "utf-8");

    const result = await runEdit({
      path: filePath,
      edits: [{ oldText: 'const x = "hi";', newText: 'const x = "bye";' }],
    });

    expect(result.code).toBe("ok");
    // 被改动的行按归一化文本重写，未改动的行保留原来的行尾空白。
    await expect(readFile(filePath, "utf-8")).resolves.toBe(
      'const x = "bye";\nconst y = 1;   \n'
    );
    // diff 展示的是实际写入的内容，而不是模型给的 oldText。
    expect(result.metadata?.diff).toContain("-1 const x = “hi”;");
    expect(result.metadata?.diff).toContain('+1 const x = "bye";');
  });

  test("returns an error result when already aborted", async () => {
    const filePath = join(workdir, "aborted.txt");
    await writeFile(filePath, "content\n", "utf-8");
    const controller = new AbortController();
    controller.abort();

    const result = await runEdit(
      {
        path: filePath,
        edits: [{ oldText: "content", newText: "changed" }],
      },
      controller.signal
    );

    expect(result.code).toBe("error");
    expect(result.output).toContain("Operation aborted");
    await expect(readFile(filePath, "utf-8")).resolves.toBe("content\n");
  });

  test("maps errors to error-text and successes to text for the model", async () => {
    const input = {
      path: "missing.txt",
      edits: [{ oldText: "a", newText: "b" }],
    };
    const failure = await runEdit(input);
    const failureOutput = await editTool.toModelOutput!({
      toolCallId: "test-call",
      input,
      output: failure as never,
    });

    expect(failureOutput).toStrictEqual({
      type: "error-text",
      value: failure.output,
    });

    const filePath = join(workdir, "ok.txt");
    await writeFile(filePath, "a", "utf-8");
    const success = await runEdit({
      path: filePath,
      edits: [{ oldText: "a", newText: "b" }],
    });
    const successOutput = await editTool.toModelOutput!({
      toolCallId: "test-call",
      input: { path: filePath, edits: [{ oldText: "a", newText: "b" }] },
      output: success as never,
    });

    expect(successOutput).toStrictEqual({
      type: "text",
      value: success.output,
    });
  });
});
