import { appendFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { LedgerPayload } from "@workspace/agent-client";
import { describe, expect, test } from "vitest";

import { readLedger } from "../../src/ledger/reader.js";
import { LedgerWriter } from "../../src/ledger/writer.js";

function tempPath() {
  return join(mkdtempSync(join(tmpdir(), "ledger-")), "ledger.jsonl");
}

const process: LedgerPayload = {
  type: "note.process",
  pid: 413,
  appVersion: "0.4.1",
};

const runEnd: LedgerPayload = { type: "stream.run.end", streamId: "k1" };

describe("the session ledger file", () => {
  test("reads back what it appended, in order", async () => {
    const path = tempPath();
    const writer = LedgerWriter.open({ path });
    writer.append(process, "e1");
    writer.append(runEnd, "e1");
    writer.close();

    const read = await readLedger(path);

    expect(read.records.map((record) => record.type)).toStrictEqual([
      "note.process",
      "stream.run.end",
    ]);
    expect(read.records.map((record) => record.line)).toStrictEqual([1, 2]);
    expect(read.records[0]).toMatchObject({
      v: 1,
      epoch: "e1",
      at: expect.any(Number),
    });
    expect(read.skipped).toBe(0);
    expect(read.tailTruncated).toBeFalsy();
  });

  test("drops a last line that a crash cut in half", async () => {
    const path = tempPath();
    const writer = LedgerWriter.open({ path });
    writer.append(process, "e1");
    writer.close();
    appendFileSync(path, '{"line":2,"v":1,"at":1,"epoch":"e', "utf-8");

    const read = await readLedger(path);

    expect(read.records).toHaveLength(1);
    expect(read.tailTruncated).toBeTruthy();
    expect(read.skipped).toBe(0);
  });

  test("skips a broken line in the middle and counts it", async () => {
    const path = tempPath();
    const writer = LedgerWriter.open({ path });
    writer.append(process, "e1");
    writer.close();
    appendFileSync(path, "not a record\n", "utf-8");

    const second = LedgerWriter.open({ path });
    second.append(runEnd, "e1");
    second.close();

    const read = await readLedger(path);

    expect(read.records.map((record) => record.type)).toStrictEqual([
      "note.process",
      "stream.run.end",
    ]);
    expect(read.records[1]?.line).toBe(2);
    expect(read.skipped).toBe(1);
    expect(read.tailTruncated).toBeFalsy();
  });

  test("asks for one page and names the next line", async () => {
    const path = tempPath();
    const writer = LedgerWriter.open({ path });
    writer.append(process, "e1");
    writer.append(process, "e1");
    writer.append(process, "e1");
    writer.close();

    const first = await readLedger(path, { limit: 2 });
    const second = await readLedger(path, { from: first.next ?? 1, limit: 2 });

    expect(first.records.map((record) => record.line)).toStrictEqual([1, 2]);
    expect(first.next).toBe(3);
    expect(second.records.map((record) => record.line)).toStrictEqual([3]);
    expect(second.next).toBeNull();
  });

  test("refuses a path it cannot write, so one caller decides what to do", () => {
    const directory = mkdtempSync(join(tmpdir(), "ledger-"));

    expect(() => LedgerWriter.open({ path: directory })).toThrow(/EISDIR/);
  });
});
