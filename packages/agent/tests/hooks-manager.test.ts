import { describe, expect, expectTypeOf, test, vi } from "vitest";

import { HooksManager } from "../src/hooks-manager.js";
import type {
  ExtensionAPI,
  HookHandler,
  SessionStartEvent,
} from "../src/hooks-manager.js";

// Declaration merging is the supported way to add custom events.
declare module "../src/hooks-manager.js" {
  interface HooksMap {
    "custom:event": HookHandler<{ payload: string }>;
    "custom:result": HookHandler<{ payload: string }, string>;
  }
}

const api: ExtensionAPI = { workdir: "/tmp/test-hooks" };

const sessionStart = (sessionId: string): SessionStartEvent => ({
  sessionId,
  name: "main",
  workdir: "/tmp/test-hooks",
});

// One mock shape covers every event: the handlers here only record calls, and
// the per-event payload types are checked by the `expectTypeOf` cases below.
const mockHook = () => vi.fn<(event: any, api: ExtensionAPI) => void>();

describe(HooksManager, () => {
  describe("on", () => {
    test("should call the handler with the event and the api", async () => {
      const hooks = new HooksManager();
      const handler = mockHook();

      hooks.on("session_start", handler);
      await hooks.emit("session_start", sessionStart("s1"), api);

      expect(handler).toHaveBeenCalledExactlyOnceWith(sessionStart("s1"), api);
    });

    test("should infer the event type from the event name", () => {
      const hooks = new HooksManager();

      hooks.on("session_start", (event, apiParam) => {
        expectTypeOf(event).toEqualTypeOf<SessionStartEvent>();
        expectTypeOf(event.sessionId).toEqualTypeOf<string>();
        expectTypeOf(apiParam).toEqualTypeOf<ExtensionAPI>();
      });
    });

    test("should run handlers in registration order", async () => {
      const hooks = new HooksManager();
      const order: string[] = [];

      hooks.on("session_start", () => {
        order.push("first");
      });
      hooks.on("session_start", () => {
        order.push("second");
      });
      await hooks.emit("session_start", sessionStart("s1"), api);

      expect(order).toStrictEqual(["first", "second"]);
    });

    test("should await each handler before running the next one", async () => {
      const hooks = new HooksManager();
      const order: string[] = [];

      hooks.on("session_start", async () => {
        await Promise.resolve();
        order.push("slow");
      });
      hooks.on("session_start", () => {
        order.push("fast");
      });
      await hooks.emit("session_start", sessionStart("s1"), api);

      expect(order).toStrictEqual(["slow", "fast"]);
    });

    test("should stop listening when the returned function is called", async () => {
      const hooks = new HooksManager();
      const handler = mockHook();

      const off = hooks.on("session_start", handler);
      off();
      await hooks.emit("session_start", sessionStart("s1"), api);

      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe("once", () => {
    test("should remove the handler before it runs", async () => {
      const hooks = new HooksManager();
      const handler = mockHook();

      hooks.once("session_start", handler);
      await hooks.emit("session_start", sessionStart("s1"), api);
      await hooks.emit("session_start", sessionStart("s2"), api);

      expect(handler).toHaveBeenCalledExactlyOnceWith(sessionStart("s1"), api);
    });
  });

  describe("priority", () => {
    test("should run higher priorities first", async () => {
      const hooks = new HooksManager();
      const order: string[] = [];

      hooks.on("session_start", () => {
        order.push("default");
      });
      hooks.on(
        "session_start",
        () => {
          order.push("low");
        },
        { priority: -1 }
      );
      hooks.on(
        "session_start",
        () => {
          order.push("high");
        },
        { priority: 10 }
      );
      await hooks.emit("session_start", sessionStart("s1"), api);

      expect(order).toStrictEqual(["high", "default", "low"]);
    });

    test("should keep registration order within one priority", async () => {
      const hooks = new HooksManager();
      const order: string[] = [];

      hooks.on(
        "session_start",
        () => {
          order.push("first");
        },
        { priority: 5 }
      );
      hooks.on(
        "session_start",
        () => {
          order.push("second");
        },
        { priority: 5 }
      );
      await hooks.emit("session_start", sessionStart("s1"), api);

      expect(order).toStrictEqual(["first", "second"]);
    });

    test("should order once handlers by priority too", async () => {
      const hooks = new HooksManager();
      const order: string[] = [];

      hooks.once("session_start", () => {
        order.push("low");
      });
      hooks.once(
        "session_start",
        () => {
          order.push("high");
        },
        { priority: 1 }
      );
      await hooks.emit("session_start", sessionStart("s1"), api);

      expect(order).toStrictEqual(["high", "low"]);
    });

    test("should order handlers registered after an emit", async () => {
      const hooks = new HooksManager();
      const order: string[] = [];

      hooks.on(
        "session_start",
        () => {
          order.push("first");
        },
        { priority: 1 }
      );
      await hooks.emit("session_start", sessionStart("s1"), api);
      hooks.on("session_start", () => {
        order.push("second");
      });
      await hooks.emit("session_start", sessionStart("s2"), api);

      expect(order).toStrictEqual(["first", "first", "second"]);
    });
  });

  describe("off", () => {
    test("should remove every handler of one event", async () => {
      const hooks = new HooksManager();
      const first = mockHook();
      const second = mockHook();
      const other = mockHook();

      hooks.on("session_start", first);
      hooks.on("session_start", second);
      hooks.on("session_end", other);
      hooks.off("session_start");

      await hooks.emit("session_start", sessionStart("s1"), api);
      await hooks.emit(
        "session_end",
        { sessionId: "s1", messageId: "m1" },
        api
      );

      expect(first).not.toHaveBeenCalled();
      expect(second).not.toHaveBeenCalled();
      expect(other).toHaveBeenCalledOnce();
    });

    test("should remove one handler only", async () => {
      const hooks = new HooksManager();
      const first = mockHook();
      const second = mockHook();

      hooks.on("session_start", first);
      hooks.on("session_start", second);
      hooks.off("session_start", first);
      await hooks.emit("session_start", sessionStart("s1"), api);

      expect(first).not.toHaveBeenCalled();
      expect(second).toHaveBeenCalledOnce();
    });

    test("should remove every handler when called without arguments", async () => {
      const hooks = new HooksManager();
      const handler = mockHook();

      hooks.on("session_start", handler);
      hooks.off();
      await hooks.emit("session_start", sessionStart("s1"), api);

      expect(handler).not.toHaveBeenCalled();
    });

    test("should ignore unknown events and handlers", () => {
      const hooks = new HooksManager();
      const handler = mockHook();

      hooks.on("session_start", handler);
      expect(() => hooks.off("session_end")).not.toThrow();
      expect(() => hooks.off("session_start", mockHook())).not.toThrow();
      expect(() => hooks.off("session_start", handler)).not.toThrow();
    });

    test("should apply an unsubscribe made during an emit to the next emit", async () => {
      const hooks = new HooksManager();
      const handler = mockHook();

      hooks.on("session_start", () => {
        hooks.off("session_start", handler);
      });
      hooks.on("session_start", handler);

      // The dispatch in flight keeps the handlers it started with...
      await hooks.emit("session_start", sessionStart("s1"), api);
      expect(handler).toHaveBeenCalledOnce();

      // ...and the removal lands on the following one.
      await hooks.emit("session_start", sessionStart("s2"), api);
      expect(handler).toHaveBeenCalledOnce();
    });
  });

  describe("emit", () => {
    test("should report a failing handler without breaking the others", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {
        /* keep the test output clean */
      });
      const hooks = new HooksManager();
      const before = mockHook();
      const after = mockHook();

      hooks.on("session_start", before);
      hooks.on("session_start", () => {
        throw new Error("boom");
      });
      hooks.on("session_start", after);

      await expect(
        hooks.emit("session_start", sessionStart("s1"), api)
      ).resolves.toBeUndefined();

      expect(before).toHaveBeenCalledOnce();
      expect(after).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledOnce();
      warn.mockRestore();
    });

    test("should await a rejecting async handler", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {
        /* keep the test output clean */
      });
      const hooks = new HooksManager();
      const after = mockHook();

      hooks.on("session_start", async () => {
        await Promise.reject(new Error("boom"));
      });
      hooks.on("session_start", after);

      await hooks.emit("session_start", sessionStart("s1"), api);

      expect(after).toHaveBeenCalledOnce();
      warn.mockRestore();
    });

    test("should do nothing when no handler is registered", async () => {
      const hooks = new HooksManager();

      await expect(
        hooks.emit("session_start", sessionStart("s1"), api)
      ).resolves.toBeUndefined();
    });

    test("should resolve with the value of the last handler that returned one", async () => {
      const hooks = new HooksManager();

      hooks.on("session_start", () => "first");
      hooks.on("session_start", async () => {
        await Promise.resolve();
        return "second";
      });

      await expect(
        hooks.emit("session_start", sessionStart("s1"), api)
      ).resolves.toBe("second");
    });

    test("should keep the previous value when a handler returns nothing", async () => {
      const hooks = new HooksManager();

      hooks.on("session_start", () => "kept");
      hooks.on("session_start", () => {
        /* abstains */
      });

      await expect(
        hooks.emit("session_start", sessionStart("s1"), api)
      ).resolves.toBe("kept");
    });

    test("should keep the previous value when a handler returns null", async () => {
      const hooks = new HooksManager();

      hooks.on("session_start", () => "kept");
      hooks.on("session_start", () => null);

      await expect(
        hooks.emit("session_start", sessionStart("s1"), api)
      ).resolves.toBe("kept");
    });

    test("should keep the previous value when a handler throws", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {
        /* keep the test output clean */
      });
      const hooks = new HooksManager();

      hooks.on("session_start", () => "kept");
      hooks.on("session_start", () => {
        throw new Error("boom");
      });

      await expect(
        hooks.emit("session_start", sessionStart("s1"), api)
      ).resolves.toBe("kept");
      warn.mockRestore();
    });

    test("should resolve with undefined when no handler returns a value", async () => {
      const hooks = new HooksManager();

      hooks.on("session_start", () => {
        /* abstains */
      });

      await expect(
        hooks.emit("session_start", sessionStart("s1"), api)
      ).resolves.toBeUndefined();
    });

    test("should type the result as the handler's R", () => {
      const hooks = new HooksManager();

      expectTypeOf(
        hooks.emit("custom:result", { payload: "hello" }, api)
      ).toEqualTypeOf<Promise<string | undefined>>();
      // An event whose handlers were registered without an `R` keeps `unknown`.
      expectTypeOf(
        hooks.emit("session_start", sessionStart("s1"), api)
      ).toEqualTypeOf<Promise<unknown>>();

      hooks.on("custom:result", () => "ok");
      // @ts-expect-error - a handler has to return the event's `R`.
      hooks.on("custom:result", () => 1);
    });
  });

  describe("custom events", () => {
    test("should emit an event registered by declaration merging", async () => {
      const hooks = new HooksManager();
      const handler = mockHook();
      const off = hooks.on("custom:event", handler);

      expectTypeOf(off).toEqualTypeOf<() => void>();
      await hooks.emit("custom:event", { payload: "hello" }, api);

      expect(handler).toHaveBeenCalledExactlyOnceWith(
        { payload: "hello" },
        api
      );
    });
  });
});
