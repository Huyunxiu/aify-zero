import { afterEach, describe, expect, test, vi } from "vitest";

import {
  createServerReadyMessage,
  isServerReadyMessage,
  postServerReadyMessage,
  SERVER_READY_TYPE,
} from "../src/server-ready";

/** `parentPort` 只在 Electron 的 utility process 里存在，测试里自己装一个。 */
interface ParentPortHost {
  parentPort?: { postMessage: (message: unknown) => void };
}

const parentPortHost = (): ParentPortHost =>
  process as unknown as ParentPortHost;

const originalParentPort = parentPortHost().parentPort;

describe("server ready message", () => {
  test("carries only the type and the origin", () => {
    expect(createServerReadyMessage("http://127.0.0.1:54321")).toStrictEqual({
      origin: "http://127.0.0.1:54321",
      type: "ready",
    });
  });

  test("accepts a message with a type and an origin", () => {
    expect(
      isServerReadyMessage({
        origin: "http://127.0.0.1:54321",
        type: SERVER_READY_TYPE,
      })
    ).toBeTruthy();
  });

  test("rejects messages of another type", () => {
    expect(
      isServerReadyMessage({ origin: "http://127.0.0.1:1", type: "log" })
    ).toBeFalsy();
  });

  test("rejects a missing, empty or non-string origin", () => {
    expect(isServerReadyMessage({ type: SERVER_READY_TYPE })).toBeFalsy();
    expect(
      isServerReadyMessage({ origin: 42, type: SERVER_READY_TYPE })
    ).toBeFalsy();
    expect(
      isServerReadyMessage({ origin: "", type: SERVER_READY_TYPE })
    ).toBeFalsy();
  });

  test("rejects values that are not objects", () => {
    expect(isServerReadyMessage(null)).toBeFalsy();
    expect(isServerReadyMessage("ready")).toBeFalsy();
    expect(isServerReadyMessage(1)).toBeFalsy();
  });

  describe("posting", () => {
    afterEach(() => {
      if (originalParentPort === undefined) {
        delete parentPortHost().parentPort;
      } else {
        parentPortHost().parentPort = originalParentPort;
      }
    });

    test("posts the ready message when the channel exists", () => {
      const postMessage = vi.fn<(message: unknown) => void>();
      parentPortHost().parentPort = { postMessage };

      postServerReadyMessage("http://127.0.0.1:54321");

      expect(postMessage).toHaveBeenCalledExactlyOnceWith({
        origin: "http://127.0.0.1:54321",
        type: SERVER_READY_TYPE,
      });
    });

    test("does nothing without the channel", () => {
      delete parentPortHost().parentPort;

      expect(() => postServerReadyMessage("http://127.0.0.1:1")).not.toThrow();
    });
  });
});
