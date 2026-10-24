import { describe, expect, it } from "vitest";

import { parseServerReadyLine } from "../src/ready-line";

describe(parseServerReadyLine, () => {
  it("accepts the ready line regardless of key order", () => {
    expect(
      parseServerReadyLine(
        JSON.stringify({ origin: "http://127.0.0.1:1", type: "ready" })
      )
    ).toStrictEqual({ origin: "http://127.0.0.1:1" });

    expect(
      parseServerReadyLine(
        JSON.stringify({ type: "ready", pid: 1, origin: "http://[::1]:2" })
      )
    ).toStrictEqual({ origin: "http://[::1]:2" });
  });

  it("ignores ordinary log lines", () => {
    expect(parseServerReadyLine("GET /api/rpc/lang 200 1ms")).toBeUndefined();
    expect(parseServerReadyLine('{"level":"info","msg":"hi"}')).toBeUndefined();
  });

  it("ignores malformed or incomplete JSON", () => {
    expect(parseServerReadyLine('{"type":"ready"')).toBeUndefined();
    expect(parseServerReadyLine("{")).toBeUndefined();
  });

  it("requires a string origin", () => {
    expect(
      parseServerReadyLine('{"type":"ready","origin":42}')
    ).toBeUndefined();
    expect(parseServerReadyLine('{"type":"ready"}')).toBeUndefined();
  });
});
