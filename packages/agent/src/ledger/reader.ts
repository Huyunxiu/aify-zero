import { readFile } from "node:fs/promises";

import type { LedgerRecord } from "@workspace/agent-client";

export type LedgerReadOptions = {
  /** The first line to return. Defaults to the first line of the file. */
  from?: number;
  /** How many records to return. Defaults to the rest of the file. */
  limit?: number;
};

export type LedgerReadResult = {
  records: LedgerRecord[];
  /** Lines that did not parse and were not the last one. A person reads this number. */
  skipped: number;
  /** The last line was cut in half and was dropped. */
  tailTruncated: boolean;
  /** The line to ask for next, or null at the end of the file. */
  next: number | null;
};

/**
 * Reads a session ledger.
 *
 * A record whose family this reader does not know is returned unchanged: the projection
 * decides what to skip, and a reader that drops it here cannot report what it lost. A line
 * that does not parse is counted, not thrown.
 *
 * The whole file is read and the page is cut in memory. A ledger holds text this machine
 * already produced, and the simplest correct reader is worth more than a seek that has to
 * agree with a writer about offsets.
 */
export async function readLedger(
  path: string,
  options: LedgerReadOptions = {}
): Promise<LedgerReadResult> {
  let content: string;
  try {
    content = await readFile(path, "utf-8");
  } catch {
    return { records: [], skipped: 0, tailTruncated: false, next: null };
  }

  const from = options.from ?? 1;
  const records: LedgerRecord[] = [];
  let skipped = 0;
  let tailTruncated = false;

  const lines = content.split("\n");
  // A file that ends with a newline leaves an empty last element, which is not a line.
  const complete = lines.at(-1) === "" ? lines.slice(0, -1) : lines;
  const endsWell = lines.at(-1) === "";

  for (const [index, raw] of complete.entries()) {
    if (raw === "") {
      continue;
    }
    const record = parseLedgerLine(raw);
    if (record === null) {
      if (!endsWell && index === complete.length - 1) {
        tailTruncated = true;
      } else {
        skipped += 1;
      }
      continue;
    }
    if (record.line < from) {
      continue;
    }
    records.push(record);
  }

  const limit = options.limit ?? records.length;
  const page = records.slice(0, limit);
  const last = page.at(-1);
  const next =
    records.length > page.length && last !== undefined ? last.line + 1 : null;

  return { records: page, skipped, tailTruncated, next };
}

/**
 * One line, or nothing.
 *
 * Only the fields a reader needs to place a record are checked. The rest is kept as it
 * arrived, so a record this build does not know survives the trip to a build that does.
 *
 * The writer resumes from the tail with this same function, so "a line that is a record" has
 * one definition and the two ends of the file cannot disagree about it.
 */
export function parseLedgerLine(raw: string): LedgerRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const candidate = value as { line?: unknown; at?: unknown; type?: unknown };
  if (
    typeof candidate.line !== "number" ||
    typeof candidate.at !== "number" ||
    typeof candidate.type !== "string"
  ) {
    return null;
  }

  return candidate as LedgerRecord;
}
