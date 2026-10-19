import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import type { AgentContext } from "../../src/agent-context.js";
import { createEditFileTool } from "../../src/tools/edit-file.js";
import { withFileMutationQueue } from "../../src/tools/file-mutation-queue.js";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "aify-file-mutation-queue-"));
  tempDirs.push(dir);
  return dir;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolveDeferred!: () => void;
  const promise = new Promise<void>((resolve) => {
    resolveDeferred = resolve;
  });
  return { promise, resolve: resolveDeferred };
}

describe(withFileMutationQueue, () => {
  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
    );
  });

  test("serializes operations for the same file", async () => {
    const order: string[] = [];
    const filePath = join(tmpdir(), "aify-queue-same-file");

    const first = withFileMutationQueue(filePath, async () => {
      order.push("first:start");
      await delay(20);
      order.push("first:end");
    });
    const second = withFileMutationQueue(filePath, () => {
      order.push("second:start");
      order.push("second:end");
      return Promise.resolve();
    });

    await Promise.all([first, second]);
    expect(order).toStrictEqual([
      "first:start",
      "first:end",
      "second:start",
      "second:end",
    ]);
  });

  test("lets different files proceed in parallel", async () => {
    const releaseFirst = createDeferred();
    const secondStarted = createDeferred();
    let firstFinished = false;

    const first = withFileMutationQueue(
      join(tmpdir(), "aify-queue-parallel-a"),
      async () => {
        await releaseFirst.promise;
        firstFinished = true;
      }
    );
    const second = withFileMutationQueue(
      join(tmpdir(), "aify-queue-parallel-b"),
      () => {
        secondStarted.resolve();
        return Promise.resolve();
      }
    );

    // 第二个文件不必等第一个文件释放。
    await secondStarted.promise;
    expect(firstFinished).toBeFalsy();

    releaseFirst.resolve();
    await Promise.all([first, second]);
  });

  test("runs many same-file operations one at a time", async () => {
    let active = 0;
    let maxActive = 0;
    const filePath = join(tmpdir(), "aify-queue-many");

    await Promise.all(
      Array.from({ length: 5 }, () =>
        withFileMutationQueue(filePath, async () => {
          active++;
          maxActive = Math.max(maxActive, active);
          await delay(5);
          active--;
        })
      )
    );

    expect(maxActive).toBe(1);
  });

  test("shares one queue between symlink aliases", async () => {
    const dir = await createTempDir();
    const targetPath = join(dir, "target.txt");
    const aliasPath = join(dir, "alias.txt");
    await writeFile(targetPath, "hello\n", "utf-8");
    await symlink(targetPath, aliasPath);

    const order: string[] = [];
    const releaseFirst = createDeferred();

    const first = withFileMutationQueue(targetPath, async () => {
      order.push("target:start");
      await releaseFirst.promise;
      order.push("target:end");
    });
    const second = withFileMutationQueue(aliasPath, () => {
      order.push("alias:start");
      return Promise.resolve();
    });

    // 别名指向同一个真实文件，必须排在第一条之后。
    await delay(20);
    expect(order).toStrictEqual(["target:start"]);

    releaseFirst.resolve();
    await Promise.all([first, second]);
    expect(order).toStrictEqual(["target:start", "target:end", "alias:start"]);
  });

  test("resolves `..` aliases to the same queue", async () => {
    const dir = await createTempDir();
    const targetPath = join(dir, "target.txt");
    const aliasPath = join(dir, "sub", "..", "target.txt");
    await writeFile(targetPath, "hello\n", "utf-8");

    const order: string[] = [];
    const releaseFirst = createDeferred();

    const first = withFileMutationQueue(targetPath, async () => {
      order.push("target:start");
      await releaseFirst.promise;
      order.push("target:end");
    });
    const second = withFileMutationQueue(aliasPath, () => {
      order.push("alias:start");
      return Promise.resolve();
    });

    await delay(20);
    expect(order).toStrictEqual(["target:start"]);

    releaseFirst.resolve();
    await Promise.all([first, second]);
    expect(order).toStrictEqual(["target:start", "target:end", "alias:start"]);
  });

  test("releases the queue when an operation throws", async () => {
    const order: string[] = [];
    const filePath = join(tmpdir(), "aify-queue-throw");

    const failing = withFileMutationQueue(filePath, () =>
      Promise.reject(new Error("boom"))
    );
    const next = withFileMutationQueue(filePath, () => {
      order.push("next");
      return Promise.resolve();
    });

    await expect(failing).rejects.toThrow("boom");
    await next;
    expect(order).toStrictEqual(["next"]);
  });

  test("keeps both concurrent edit-file edits on the same file", async () => {
    const dir = await createTempDir();
    const filePath = join(dir, "parallel.txt");
    await writeFile(filePath, "alpha\nbeta\n", "utf-8");

    const agentContext = { workdir: dir } as AgentContext;
    const editTool = createEditFileTool({ agentContext });
    const runEdit = (oldText: string, newText: string) =>
      editTool.execute(
        { path: filePath, edits: [{ oldText, newText }] },
        {
          toolCallId: `edit-${oldText}`,
          messages: [],
          context: agentContext,
        }
      ) as unknown as Promise<{ code: "ok" | "error" }>;

    const [first, second] = await Promise.all([
      runEdit("alpha", "ALPHA"),
      runEdit("beta", "BETA"),
    ]);

    expect([first.code, second.code]).toStrictEqual(["ok", "ok"]);
    await expect(readFile(filePath, "utf-8")).resolves.toBe("ALPHA\nBETA\n");
  });
});
