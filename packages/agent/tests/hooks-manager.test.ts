import { describe, expect, expectTypeOf, test, vi } from "vitest";

import {
  applyPatches,
  applyRuntimeSettingsPatches,
  HooksManager,
} from "../src/hooks-manager.js";
import type {
  HookContext,
  HookHandler,
  StepEndEvent,
  StepStartEvent,
  TurnStartEvent,
  RuntimeSettingsPatch,
} from "../src/hooks-manager.js";

// Declaration merging is the supported way to add custom events.
declare module "../src/hooks-manager.js" {
  interface HooksMap {
    "custom:event": HookHandler<{ payload: string }>;
    "custom:result": HookHandler<{ payload: string }, string>;
  }
}

const api: HookContext = { projectDir: "/tmp/test-hooks" };

const turnStart = (sessionId: string): TurnStartEvent => ({
  sessionId,
  name: "main",
  projectDirs: ["/tmp/test-hooks"],
  sessionDir: "/tmp/test-hooks-sessions",
  modelId: "test-model",
});

// One mock shape covers every event: the handlers here only record calls, and
// the per-event payload types are checked by the `expectTypeOf` cases below.
// The return type stays a runtime settings patch so that `turn_start` accepts it;
// the other events widen it to `unknown`.
const mockHook = () =>
  vi.fn<(event: any, api: HookContext) => RuntimeSettingsPatch | undefined>();

describe(HooksManager, () => {
  describe("on", () => {
    test("should call the handler with the event and the api", async () => {
      const hooks = new HooksManager();
      const handler = mockHook();

      hooks.on("turn_start", handler);
      await hooks.emit("turn_start", turnStart("s1"), api);

      expect(handler).toHaveBeenCalledExactlyOnceWith(turnStart("s1"), api);
    });

    test("should infer the event type from the event name", () => {
      const hooks = new HooksManager();

      hooks.on("turn_start", (event, apiParam) => {
        expectTypeOf(event).toEqualTypeOf<TurnStartEvent>();
        expectTypeOf(event.sessionId).toEqualTypeOf<string>();
        expectTypeOf(event.modelId).toEqualTypeOf<string>();
        expectTypeOf(apiParam).toEqualTypeOf<HookContext>();
      });

      hooks.on("step_start", (event) => {
        expectTypeOf(event).toEqualTypeOf<StepStartEvent>();
      });

      hooks.on("step_end", (event) => {
        expectTypeOf(event).toEqualTypeOf<StepEndEvent>();
        expectTypeOf(event.status).toEqualTypeOf<
          "done" | "error" | "aborted"
        >();
      });
    });

    test("should run handlers in registration order", async () => {
      const hooks = new HooksManager();
      const order: string[] = [];

      hooks.on("turn_start", () => {
        order.push("first");
      });
      hooks.on("turn_start", () => {
        order.push("second");
      });
      await hooks.emit("turn_start", turnStart("s1"), api);

      expect(order).toStrictEqual(["first", "second"]);
    });

    test("should await each handler before running the next one", async () => {
      const hooks = new HooksManager();
      const order: string[] = [];

      hooks.on("turn_start", async () => {
        await Promise.resolve();
        order.push("slow");
        return null;
      });
      hooks.on("turn_start", () => {
        order.push("fast");
      });
      await hooks.emit("turn_start", turnStart("s1"), api);

      expect(order).toStrictEqual(["slow", "fast"]);
    });

    test("should stop listening when the returned function is called", async () => {
      const hooks = new HooksManager();
      const handler = mockHook();

      const off = hooks.on("turn_start", handler);
      off();
      await hooks.emit("turn_start", turnStart("s1"), api);

      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe("once", () => {
    test("should remove the handler before it runs", async () => {
      const hooks = new HooksManager();
      const handler = mockHook();

      hooks.once("turn_start", handler);
      await hooks.emit("turn_start", turnStart("s1"), api);
      await hooks.emit("turn_start", turnStart("s2"), api);

      expect(handler).toHaveBeenCalledExactlyOnceWith(turnStart("s1"), api);
    });
  });

  describe("priority", () => {
    test("should run higher priorities first", async () => {
      const hooks = new HooksManager();
      const order: string[] = [];

      hooks.on("turn_start", () => {
        order.push("default");
      });
      hooks.on(
        "turn_start",
        () => {
          order.push("low");
        },
        { priority: -1 }
      );
      hooks.on(
        "turn_start",
        () => {
          order.push("high");
        },
        { priority: 10 }
      );
      await hooks.emit("turn_start", turnStart("s1"), api);

      expect(order).toStrictEqual(["high", "default", "low"]);
    });

    test("should keep registration order within one priority", async () => {
      const hooks = new HooksManager();
      const order: string[] = [];

      hooks.on(
        "turn_start",
        () => {
          order.push("first");
        },
        { priority: 5 }
      );
      hooks.on(
        "turn_start",
        () => {
          order.push("second");
        },
        { priority: 5 }
      );
      await hooks.emit("turn_start", turnStart("s1"), api);

      expect(order).toStrictEqual(["first", "second"]);
    });

    test("should order once handlers by priority too", async () => {
      const hooks = new HooksManager();
      const order: string[] = [];

      hooks.once("turn_start", () => {
        order.push("low");
      });
      hooks.once(
        "turn_start",
        () => {
          order.push("high");
        },
        { priority: 1 }
      );
      await hooks.emit("turn_start", turnStart("s1"), api);

      expect(order).toStrictEqual(["high", "low"]);
    });

    test("should order handlers registered after an emit", async () => {
      const hooks = new HooksManager();
      const order: string[] = [];

      hooks.on(
        "turn_start",
        () => {
          order.push("first");
        },
        { priority: 1 }
      );
      await hooks.emit("turn_start", turnStart("s1"), api);
      hooks.on("turn_start", () => {
        order.push("second");
      });
      await hooks.emit("turn_start", turnStart("s2"), api);

      expect(order).toStrictEqual(["first", "first", "second"]);
    });
  });

  describe("off", () => {
    test("should remove every handler of one event", async () => {
      const hooks = new HooksManager();
      const first = mockHook();
      const second = mockHook();
      const other = mockHook();

      hooks.on("turn_start", first);
      hooks.on("turn_start", second);
      hooks.on("turn_end", other);
      hooks.off("turn_start");

      await hooks.emit("turn_start", turnStart("s1"), api);
      await hooks.emit("turn_end", { sessionId: "s1" }, api);

      expect(first).not.toHaveBeenCalled();
      expect(second).not.toHaveBeenCalled();
      expect(other).toHaveBeenCalledOnce();
    });

    test("should remove one handler only", async () => {
      const hooks = new HooksManager();
      const first = mockHook();
      const second = mockHook();

      hooks.on("turn_start", first);
      hooks.on("turn_start", second);
      hooks.off("turn_start", first);
      await hooks.emit("turn_start", turnStart("s1"), api);

      expect(first).not.toHaveBeenCalled();
      expect(second).toHaveBeenCalledOnce();
    });

    test("should remove every handler when called without arguments", async () => {
      const hooks = new HooksManager();
      const handler = mockHook();

      hooks.on("turn_start", handler);
      hooks.off();
      await hooks.emit("turn_start", turnStart("s1"), api);

      expect(handler).not.toHaveBeenCalled();
    });

    test("should ignore unknown events and handlers", () => {
      const hooks = new HooksManager();
      const handler = mockHook();

      hooks.on("turn_start", handler);
      expect(() => hooks.off("turn_end")).not.toThrow();
      expect(() => hooks.off("turn_start", mockHook())).not.toThrow();
      expect(() => hooks.off("turn_start", handler)).not.toThrow();
    });

    test("should apply an unsubscribe made during an emit to the next emit", async () => {
      const hooks = new HooksManager();
      const handler = mockHook();

      hooks.on("turn_start", () => {
        hooks.off("turn_start", handler);
      });
      hooks.on("turn_start", handler);

      // The dispatch in flight keeps the handlers it started with...
      await hooks.emit("turn_start", turnStart("s1"), api);
      expect(handler).toHaveBeenCalledOnce();

      // ...and the removal lands on the following one.
      await hooks.emit("turn_start", turnStart("s2"), api);
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

      hooks.on("turn_start", before);
      hooks.on("turn_start", () => {
        throw new Error("boom");
      });
      hooks.on("turn_start", after);

      await expect(
        hooks.emit("turn_start", turnStart("s1"), api)
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

      hooks.on("turn_start", async () => {
        await Promise.reject(new Error("boom"));
        return null;
      });
      hooks.on("turn_start", after);

      await hooks.emit("turn_start", turnStart("s1"), api);

      expect(after).toHaveBeenCalledOnce();
      warn.mockRestore();
    });

    test("should do nothing when no handler is registered", async () => {
      const hooks = new HooksManager();

      await expect(
        hooks.emit("turn_start", turnStart("s1"), api)
      ).resolves.toBeUndefined();
    });

    test("should resolve with the value of the last handler that returned one", async () => {
      const hooks = new HooksManager();

      hooks.on("custom:result", () => "first");
      hooks.on("custom:result", async () => {
        await Promise.resolve();
        return "second";
      });

      await expect(
        hooks.emit("custom:result", { payload: "s1" }, api)
      ).resolves.toBe("second");
    });

    test("should keep the previous value when a handler returns nothing", async () => {
      const hooks = new HooksManager();

      hooks.on("custom:result", () => "kept");
      hooks.on("custom:result", () => {
        /* abstains */
      });

      await expect(
        hooks.emit("custom:result", { payload: "s1" }, api)
      ).resolves.toBe("kept");
    });

    test("should keep the previous value when a handler returns null", async () => {
      const hooks = new HooksManager();

      hooks.on("custom:result", () => "kept");
      hooks.on("custom:result", () => null);

      await expect(
        hooks.emit("custom:result", { payload: "s1" }, api)
      ).resolves.toBe("kept");
    });

    test("should keep the previous value when a handler throws", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {
        /* keep the test output clean */
      });
      const hooks = new HooksManager();

      hooks.on("custom:result", () => "kept");
      hooks.on("custom:result", () => {
        throw new Error("boom");
      });

      await expect(
        hooks.emit("custom:result", { payload: "s1" }, api)
      ).resolves.toBe("kept");
      warn.mockRestore();
    });

    test("should resolve with undefined when no handler returns a value", async () => {
      const hooks = new HooksManager();

      hooks.on("turn_start", () => {
        /* abstains */
      });

      await expect(
        hooks.emit("turn_start", turnStart("s1"), api)
      ).resolves.toBeUndefined();
    });

    test("should type the result as the handler's R", () => {
      const hooks = new HooksManager();

      expectTypeOf(
        hooks.emit("custom:result", { payload: "hello" }, api)
      ).toEqualTypeOf<Promise<string | null | undefined>>();
      // An event whose handlers were registered without an `R` keeps `unknown`.
      expectTypeOf(
        hooks.emit("turn_start", turnStart("s1"), api)
      ).toEqualTypeOf<Promise<RuntimeSettingsPatch | null | undefined>>();

      hooks.on("custom:result", () => "ok");
      // @ts-expect-error - a handler has to return the event's `R`.
      hooks.on("custom:result", () => 1);
    });
  });

  describe("emitAsyncHooks", () => {
    test("should resolve with every value the handlers returned, in run order", async () => {
      const hooks = new HooksManager();

      hooks.on("custom:result", () => "first");
      hooks.on("custom:result", async () => {
        await Promise.resolve();
        return "second";
      });

      await expect(
        hooks.emitAsyncHooks("custom:result", { payload: "s1" }, api)
      ).resolves.toStrictEqual(["first", "second"]);
    });

    test("should drop the handlers that abstained", async () => {
      const hooks = new HooksManager();

      hooks.on("custom:result", () => "kept");
      hooks.on("custom:result", () => {
        /* abstains */
      });
      hooks.on("custom:result", () => null);

      await expect(
        hooks.emitAsyncHooks("custom:result", { payload: "s1" }, api)
      ).resolves.toStrictEqual(["kept"]);
    });

    test("should drop the handlers that threw", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {
        /* keep the test output clean */
      });
      const hooks = new HooksManager();

      hooks.on("custom:result", () => "before");
      hooks.on("custom:result", () => {
        throw new Error("boom");
      });
      hooks.on("custom:result", () => "after");

      await expect(
        hooks.emitAsyncHooks("custom:result", { payload: "s1" }, api)
      ).resolves.toStrictEqual(["before", "after"]);
      warn.mockRestore();
    });

    test("should resolve with an empty array when no handler is registered", async () => {
      const hooks = new HooksManager();

      await expect(
        hooks.emitAsyncHooks("turn_start", turnStart("s1"), api)
      ).resolves.toStrictEqual([]);
    });

    test("should run the handlers in the same order as emit", async () => {
      const hooks = new HooksManager();
      const order: string[] = [];

      hooks.on(
        "custom:result",
        () => {
          order.push("high");
          return "high";
        },
        { priority: 10 }
      );
      hooks.on("custom:result", () => {
        order.push("low");
        return "low";
      });

      await expect(
        hooks.emitAsyncHooks("custom:result", { payload: "s1" }, api)
      ).resolves.toStrictEqual(["high", "low"]);
      expect(order).toStrictEqual(["high", "low"]);
    });

    test("should type the results as the handler's R", () => {
      const hooks = new HooksManager();

      expectTypeOf(
        hooks.emitAsyncHooks("custom:result", { payload: "hello" }, api)
      ).toEqualTypeOf<Promise<string[]>>();
      // An event whose handlers were registered without an `R` keeps `unknown`.
      expectTypeOf(
        hooks.emitAsyncHooks("turn_start", turnStart("s1"), api)
      ).toEqualTypeOf<Promise<RuntimeSettingsPatch[]>>();
    });
  });

  describe("start patches", () => {
    test("should keep the base state when no handler has an opinion", () => {
      expect(
        applyRuntimeSettingsPatches(
          { modelId: "base", instructions: "base prompt" },
          []
        )
      ).toStrictEqual({ modelId: "base", instructions: "base prompt" });
      expect(
        applyRuntimeSettingsPatches(
          { modelId: "base", instructions: "base prompt" },
          [{}, { modelId: "" }]
        )
      ).toStrictEqual({ modelId: "base", instructions: "base prompt" });
    });

    test("should let the last non-empty model id win", () => {
      const state = applyRuntimeSettingsPatches(
        { modelId: "base", instructions: "" },
        [{ modelId: "first" }, { modelId: "" }, { modelId: "last" }]
      );

      expect(state.modelId).toBe("last");
    });

    test("should apply string and function prompt patches in order", () => {
      const state = applyRuntimeSettingsPatches(
        { modelId: "base", instructions: "base" },
        [
          { instructions: (prompt) => `${prompt}+one` },
          { instructions: "replaced" },
          { instructions: (prompt) => `${prompt}+two` },
        ]
      );

      expect(state.instructions).toBe("replaced+two");
    });

    test("should keep the previous prompt when a patch function throws", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {
        /* keep the test output clean */
      });
      const state = applyRuntimeSettingsPatches(
        { modelId: "base", instructions: "base" },
        [
          { instructions: "changed" },
          {
            instructions: () => {
              throw new Error("boom");
            },
          },
        ]
      );

      expect(state.instructions).toBe("changed");
      expect(warn).toHaveBeenCalledOnce();
      warn.mockRestore();
    });

    test("should merge a new field without a dedicated apply function", () => {
      // 这是通用方案的证明：T 多一个字段，applyPatches 一行都不用改。
      const state = applyPatches(
        { modelId: "base", instructions: "", extra: 1 },
        [{ extra: (value) => value + 1 }, { extra: 10 }]
      );

      expect(state).toStrictEqual({
        modelId: "base",
        instructions: "",
        extra: 10,
      });
    });

    test("should skip blank strings only when the field asks for it", () => {
      const state = applyPatches(
        { modelId: "base", instructions: "base prompt" },
        [{ modelId: "", instructions: "" }],
        { modelId: { skipBlank: true } }
      );

      expect(state).toStrictEqual({ modelId: "base", instructions: "" });
    });

    test("should type turn_start handlers as patch producers", () => {
      const hooks = new HooksManager();

      hooks.on("turn_start", (event) => ({
        modelId: event.modelId,
        instructions: (prompt) => prompt,
      }));
      hooks.on("step_start", (event) => {
        expectTypeOf(event.modelId).toEqualTypeOf<string>();
        return { modelId: event.modelId };
      });
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
