import { describe, expect, test } from "vitest";

import {
  decodeTerminalFrame,
  encodeTerminalControl,
  encodeTerminalInput,
  encodeTerminalServerControl,
  parseTerminalServerControl,
  TERMINAL_CONTROL_FRAME,
  TERMINAL_CONTROL_LIMIT,
  TERMINAL_INPUT_FRAME,
} from "../src/terminal-protocol";

describe("terminal protocol", () => {
  test("encodes input text as a tagged UTF-8 frame", () => {
    const frame = encodeTerminalInput("語😀");

    expect(frame[0]).toBe(TERMINAL_INPUT_FRAME);
    expect(new TextDecoder().decode(frame.subarray(1))).toBe("語😀");
  });

  test("keeps raw input bytes unchanged", () => {
    const frame = encodeTerminalInput(new Uint8Array([0, 1, 127, 128, 255]));

    expect(frame[0]).toBe(TERMINAL_INPUT_FRAME);
    expect([...frame.subarray(1)]).toStrictEqual([0, 1, 127, 128, 255]);
  });

  test("decodes an input frame", () => {
    const frame = encodeTerminalInput("ls\r");

    expect(decodeTerminalFrame(frame)).toStrictEqual({
      data: frame.subarray(1),
      kind: "input",
    });
  });

  test("encodes and decodes a resize control frame", () => {
    const frame = encodeTerminalControl({
      cols: 120,
      rows: 40,
      type: "resize",
    });

    expect(frame[0]).toBe(TERMINAL_CONTROL_FRAME);
    expect(decodeTerminalFrame(frame)).toStrictEqual({
      control: { cols: 120, rows: 40, type: "resize" },
      kind: "control",
    });
  });

  test("rejects resize values outside the supported range", () => {
    expect(() =>
      encodeTerminalControl({ cols: 0, rows: 40, type: "resize" })
    ).toThrow(/out of range/);
    expect(() =>
      encodeTerminalControl({ cols: 120, rows: 4097, type: "resize" })
    ).toThrow(/out of range/);
    expect(() =>
      encodeTerminalControl({ cols: 120.5, rows: 40, type: "resize" })
    ).toThrow(/out of range/);
  });

  test("rejects an empty frame", () => {
    expect(() => decodeTerminalFrame(new Uint8Array())).toThrow(/empty/);
  });

  test("rejects an unknown frame tag", () => {
    expect(() => decodeTerminalFrame(new Uint8Array([9, 1]))).toThrow(
      /unknown frame tag/
    );
  });

  test("rejects a control frame that is not JSON", () => {
    const payload = new TextEncoder().encode("not json");
    const frame = new Uint8Array(payload.byteLength + 1);
    frame[0] = TERMINAL_CONTROL_FRAME;
    frame.set(payload, 1);

    expect(() => decodeTerminalFrame(frame)).toThrow(/not JSON/);
  });

  test("rejects an oversized control frame", () => {
    const payload = new Uint8Array(TERMINAL_CONTROL_LIMIT + 1).fill(32);
    const frame = new Uint8Array(payload.byteLength + 1);
    frame[0] = TERMINAL_CONTROL_FRAME;
    frame.set(payload, 1);

    expect(() => decodeTerminalFrame(frame)).toThrow(/too large/);
  });

  test("rejects an unexpected control field", () => {
    const payload = new TextEncoder().encode(
      '{"type":"resize","cols":80,"rows":24,"extra":1}'
    );
    const frame = new Uint8Array(payload.byteLength + 1);
    frame[0] = TERMINAL_CONTROL_FRAME;
    frame.set(payload, 1);

    expect(() => decodeTerminalFrame(frame)).toThrow(
      /unexpected control field/
    );
  });

  test("encodes and parses every server control", () => {
    const ready = {
      cwd: "/tmp/project",
      pid: 42,
      type: "ready" as const,
    };
    const exit = { exitCode: 0, type: "exit" as const };
    const error = { message: "spawn failed", type: "error" as const };

    expect(
      parseTerminalServerControl(encodeTerminalServerControl(ready))
    ).toStrictEqual(ready);
    expect(
      parseTerminalServerControl(encodeTerminalServerControl(exit))
    ).toStrictEqual(exit);
    expect(
      parseTerminalServerControl(encodeTerminalServerControl(error))
    ).toStrictEqual(error);
  });

  test("ignores unknown or malformed server controls", () => {
    expect(parseTerminalServerControl("not json")).toBeNull();
    expect(parseTerminalServerControl('{"type":"future"}')).toBeNull();
    expect(
      parseTerminalServerControl('{"type":"exit","exitCode":"0"}')
    ).toBeNull();
    expect(parseTerminalServerControl('{"type":"ready"}')).toBeNull();
    expect(parseTerminalServerControl("[]")).toBeNull();
  });
});
