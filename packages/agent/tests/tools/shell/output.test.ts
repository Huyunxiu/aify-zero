import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  MAX_OUTPUT_BYTES,
  ShellOutputCollector,
} from "../../../src/tools/shell/output.js";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "aify-shell-output-"));
  tempDirs.push(dir);
  return dir;
}

async function readSpill(path: string): Promise<string> {
  return await readFile(path, "utf-8");
}

describe(ShellOutputCollector, () => {
  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
    );
  });

  test("should keep short output untouched", async () => {
    const collector = new ShellOutputCollector({ dir: await createTempDir() });
    collector.push("stdout", Buffer.from("hello\n"));
    collector.push("stderr", Buffer.from("warn\n"));

    const snapshot = await collector.finish();

    expect(snapshot.stdout).toBe("hello\n");
    expect(snapshot.stderr).toBe("warn\n");
    expect(snapshot.truncated).toBeFalsy();
    expect(snapshot.spillPath).toBeUndefined();
  });

  test("should not split a multi-byte character across chunks", async () => {
    const collector = new ShellOutputCollector({ dir: await createTempDir() });
    const bytes = Buffer.from("héllo", "utf-8");
    collector.push("stdout", bytes.subarray(0, 2));
    collector.push("stdout", bytes.subarray(2));

    const snapshot = await collector.finish();

    expect(snapshot.stdout).toBe("héllo");
    expect(snapshot.truncated).toBeFalsy();
  });

  test("should keep the last 2000 lines when the line limit is hit", async () => {
    const collector = new ShellOutputCollector({ dir: await createTempDir() });
    const lines = Array.from({ length: 3000 }, (_, index) => `line-${index}`);
    collector.push("stdout", Buffer.from(`${lines.join("\n")}\n`));

    const snapshot = await collector.finish();

    expect(snapshot.truncated).toBeTruthy();
    const retained = snapshot.stdout.trimEnd().split("\n");
    expect(retained).toHaveLength(2000);
    expect(retained[0]).toBe("line-1000");
    expect(retained.at(-1)).toBe("line-2999");
    expect(snapshot.stdout.endsWith("\n")).toBeTruthy();
  });

  test("should keep the last bytes of a single over-long line", async () => {
    const collector = new ShellOutputCollector({ dir: await createTempDir() });
    collector.push("stdout", Buffer.from("a".repeat(120_000)));

    const snapshot = await collector.finish();

    expect(snapshot.truncated).toBeTruthy();
    expect(snapshot.stdout).toHaveLength(MAX_OUTPUT_BYTES);
    expect(snapshot.stdout).toMatch(/^a+$/u);
  });

  test("should spill the complete output in arrival order", async () => {
    const collector = new ShellOutputCollector({ dir: await createTempDir() });
    const big = "x".repeat(60_000);
    collector.push("stdout", Buffer.from("one\n"));
    collector.push("stderr", Buffer.from("two\n"));
    collector.push("stdout", Buffer.from(big));

    const snapshot = await collector.finish();

    expect(snapshot.truncated).toBeTruthy();
    expect(snapshot.spillPath).toBeDefined();
    const spilled = await readSpill(snapshot.spillPath!);
    expect(spilled.startsWith("one\ntwo\n")).toBeTruthy();
    expect(spilled).toBe(`one\ntwo\n${big}`);
  });

  test("should stop spilling at the configured cap", async () => {
    const collector = new ShellOutputCollector({
      dir: await createTempDir(),
      maxBytes: 5,
      maxSpillBytes: 10,
    });
    collector.push("stdout", Buffer.from("a".repeat(100)));

    const snapshot = await collector.finish();

    expect(snapshot.truncated).toBeTruthy();
    expect(snapshot.spillTruncated).toBeTruthy();
    expect(snapshot.spillPath).toBeDefined();
    await expect(readSpill(snapshot.spillPath!)).resolves.toHaveLength(10);
  });

  test("should resolve the same snapshot when finished twice", async () => {
    const collector = new ShellOutputCollector({ dir: await createTempDir() });
    collector.push("stdout", Buffer.from("once\n"));

    const first = await collector.finish();
    const second = await collector.finish();

    expect(second).toBe(first);
  });
});
