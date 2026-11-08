import { describe, expect, test } from "vitest";

import {
  applyBrowserFrame,
  projectBrowserFrame,
} from "../src/elements/session-panel/browser-frame";
import type {
  BrowserFrame,
  BrowserFrameTarget,
} from "../src/elements/session-panel/browser-frame";

const BOUNDS = { height: 480, width: 640, x: 100, y: 48 };

/** 记录适配器收到的调用。 */
function fakeTarget(): {
  readonly calls: string[];
  readonly target: BrowserFrameTarget;
} {
  const calls: string[] = [];
  const target: BrowserFrameTarget = {
    setBounds: (id, bounds) => {
      calls.push(
        `bounds ${id} ${bounds.x},${bounds.y},${bounds.width}x${bounds.height}`
      );
    },
    setVisible: (id, visible) => {
      calls.push(`visible ${id} ${String(visible)}`);
    },
  };

  return { calls, target };
}

describe("browser frame projection", () => {
  test("a visible tab shows the view inside its placeholder", () => {
    expect(
      projectBrowserFrame({
        active: true,
        animationSettled: true,
        bounds: BOUNDS,
        occluded: false,
      })
    ).toStrictEqual({ bounds: BOUNDS, visible: true });
  });

  test("an inactive tab hides the view", () => {
    expect(
      projectBrowserFrame({
        active: false,
        animationSettled: true,
        bounds: BOUNDS,
        occluded: false,
      })
    ).toStrictEqual({ bounds: BOUNDS, visible: false });
  });

  test("the panel animation and modals hide the view", () => {
    const visible = {
      active: true,
      animationSettled: true,
      bounds: BOUNDS,
      occluded: false,
    };

    expect(
      projectBrowserFrame({ ...visible, animationSettled: false })
    ).toStrictEqual({ bounds: BOUNDS, visible: false });
    expect(projectBrowserFrame({ ...visible, occluded: true })).toStrictEqual({
      bounds: BOUNDS,
      visible: false,
    });
  });

  test("a zero-sized placeholder is not visible", () => {
    expect(
      projectBrowserFrame({
        active: true,
        animationSettled: true,
        bounds: { height: 0, width: 640, x: 0, y: 0 },
        occluded: false,
      })
    ).toStrictEqual({
      bounds: { height: 0, width: 640, x: 0, y: 0 },
      visible: false,
    });
  });

  test("no measurement means no frame", () => {
    expect(
      projectBrowserFrame({
        active: true,
        animationSettled: true,
        bounds: null,
        occluded: false,
      })
    ).toBeNull();
  });
});

describe("applying a browser frame", () => {
  test("bounds go out before the view is shown", () => {
    const { calls, target } = fakeTarget();
    const next: BrowserFrame = { bounds: BOUNDS, visible: true };

    const applied = applyBrowserFrame(target, "view-1", null, next);

    expect(applied).toBe(next);
    expect(calls).toStrictEqual([
      "bounds view-1 100,48,640x480",
      "visible view-1 true",
    ]);
  });

  test("an unchanged frame sends nothing", () => {
    const { calls, target } = fakeTarget();
    const frame: BrowserFrame = { bounds: BOUNDS, visible: true };

    const applied = applyBrowserFrame(target, "view-1", frame, { ...frame });

    expect(applied).toBeDefined();
    expect(calls).toStrictEqual([]);
  });

  test("moving the placeholder only resends bounds", () => {
    const { calls, target } = fakeTarget();
    const applied: BrowserFrame = { bounds: BOUNDS, visible: true };
    const moved = { ...BOUNDS, x: 120, y: 60 };

    applyBrowserFrame(target, "view-1", applied, {
      bounds: moved,
      visible: true,
    });

    expect(calls).toStrictEqual(["bounds view-1 120,60,640x480"]);
  });

  test("hiding leaves bounds in place", () => {
    const { calls, target } = fakeTarget();
    const applied: BrowserFrame = { bounds: BOUNDS, visible: true };

    applyBrowserFrame(target, "view-1", applied, {
      bounds: BOUNDS,
      visible: false,
    });

    expect(calls).toStrictEqual(["visible view-1 false"]);
  });
});
