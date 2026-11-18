import type { Tray } from "electron";
/**
 * 托盘：左键开应用，右键弹菜单。
 *
 * 这两个键的分工只能靠事件做——`setContextMenu` 在 macOS 和 Windows 上会让左键
 * 也弹菜单，那就成了「点一下图标先看到两张菜单项」。Linux 是例外：appindicator
 * 不派发点击事件，菜单必须挂上去才有人能打开它。
 *
 * 托盘和菜单都是替身，被验的是我们自己的那几行接线。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { setDesktopLanguage } from "../src/i18n";
import { createTray, updateTrayMenu } from "../src/tray";

const electron = vi.hoisted(() => {
  const trays: FakeTray[] = [];

  class FakeImage {
    isEmpty(): boolean {
      return false;
    }

    setTemplateImage(): void {}
  }

  class FakeTray {
    readonly image: FakeImage;
    readonly menus: Template[] = [];
    readonly listeners = new Map<string, () => void>();
    readonly popped: Template[] = [];

    constructor(image: FakeImage) {
      this.image = image;
      trays.push(this);
    }

    setToolTip(): void {}

    on(event: string, listener: () => void): void {
      this.listeners.set(event, listener);
    }

    /** 挂上去的菜单；Linux 走这条路。 */
    setContextMenu(menu: Template): void {
      this.menus.push(menu);
    }

    /** 右键现弹的菜单。 */
    popUpContextMenu(menu: Template): void {
      this.popped.push(menu);
    }

    click(): void {
      this.listeners.get("click")?.();
    }

    rightClick(): void {
      this.listeners.get("right-click")?.();
    }
  }

  return {
    FakeImage,
    FakeTray,
    /** 被替身替换的那份 `electron`；只实现用到的四个成员。 */
    module: {
      Menu: { buildFromTemplate: (template: unknown) => template },
      Tray: FakeTray,
      app: { getName: () => "Aify Zero" },
      nativeImage: { createFromPath: () => new FakeImage() },
    },
    reset: () => {
      trays.length = 0;
    },
    trays,
  };
});

type Template = readonly { readonly label?: string }[];
type TrayDouble = InstanceType<typeof electron.FakeTray>;

// @ts-expect-error -- the fake implements only the members the tray uses
vi.mock(import("electron"), () => electron.module);

/** 有文案的那几条，按顺序；分隔线不算。 */
const labels = (template: Template | undefined): string[] =>
  (template ?? []).flatMap((item) =>
    typeof item.label === "string" ? [item.label] : []
  );

/** 在指定平台上跑一段；只影响这一段。 */
const onPlatform = <T>(platform: NodeJS.Platform, run: () => T): T => {
  const restore = withPlatform(platform);

  try {
    return run();
  } finally {
    restore();
  }
};

/** 装一次平台；返回恢复函数。 */
const withPlatform = (platform: NodeJS.Platform): (() => void) => {
  const original = Object.getOwnPropertyDescriptor(process, "platform");

  Object.defineProperty(process, "platform", {
    configurable: true,
    value: platform,
  });

  return () => {
    if (original !== undefined) {
      Object.defineProperty(process, "platform", original);
    }
  };
};

const create = (opened: string[] = []): TrayDouble => {
  createTray({
    iconPath: "/icons/tray.png",
    log: () => {},
    onOpen: () => opened.push("open"),
    onQuit: () => opened.push("quit"),
  });

  const [tray] = electron.trays;

  if (tray === undefined) {
    throw new Error("the tray was not created");
  }

  return tray;
};

describe("tray", () => {
  afterEach(() => {
    electron.reset();
    setDesktopLanguage("en-US");
  });

  it("opens the app on a left click and keeps the menu for the right button", () => {
    const opened: string[] = [];

    onPlatform("darwin", () => {
      const tray = create(opened);

      // 左键不该走菜单：托盘上没有挂任何菜单。
      expect(tray.menus).toHaveLength(0);

      tray.click();
      expect(opened).toStrictEqual(["open"]);
      expect(tray.popped).toHaveLength(0);

      tray.rightClick();
      expect(tray.popped).toHaveLength(1);
      expect(labels(tray.popped[0])).toStrictEqual(["Open Aify Zero", "Quit"]);
    });
  });

  it("draws the menu again when the language changes", () => {
    onPlatform("win32", () => {
      const tray = create();

      setDesktopLanguage("zh-CN");
      // 模块被替身替换了，运行时收到的就是这个假托盘。
      updateTrayMenu(tray as unknown as Tray, {
        onOpen: () => {},
        onQuit: () => {},
      });

      tray.rightClick();
      expect(labels(tray.popped.at(-1))).toStrictEqual([
        "打开 Aify Zero",
        "退出",
      ]);
    });
  });

  it("attaches the menu where the platform has no click event", () => {
    onPlatform("linux", () => {
      const tray = create();

      expect(tray.menus).toHaveLength(1);
      expect(tray.listeners.size).toBe(0);
    });
  });
});
