import { app, Menu, nativeImage, Tray } from "electron";

import { t } from "./i18n";

/** 托盘菜单的两件事；语言换了要重画菜单，所以动作单独给出。 */
export type TrayActions = {
  /** 左键点图标，或菜单里的「打开」。 */
  onOpen: () => void;
  /** 菜单里的「退出」：它是唯一能真正结束应用的入口。 */
  onQuit: () => void;
};

export type TrayOptions = TrayActions & {
  /** 图标文件的绝对路径；开发期和打包后由调用方算好。 */
  iconPath: string;
  log: (message: string) => void;
};

/** 一个托盘当前的菜单和动作；换语言时整体替换。 */
type TrayState = {
  readonly actions: TrayActions;
  readonly menu: Menu;
};

/** 菜单跟着托盘走，所以状态挂在托盘上，不另开一份全局表。 */
const states = new WeakMap<Tray, TrayState>();

const buildMenu = (actions: TrayActions): Menu =>
  Menu.buildFromTemplate([
    { click: actions.onOpen, label: t("tray.open") },
    { type: "separator" },
    { click: actions.onQuit, label: t("tray.quit") },
  ]);

/**
 * 换一份菜单。
 *
 * macOS 和 Windows 上菜单只归右键，左键直接开应用；`setContextMenu` 会让左键
 * 也弹菜单，所以那两个平台不挂它，右键时现弹。Linux 相反：appindicator 根本不
 * 派发点击事件，挂上去的菜单就是唯一入口。
 */
const setMenu = (tray: Tray, actions: TrayActions): void => {
  const menu = buildMenu(actions);

  states.set(tray, { actions, menu });

  if (process.platform === "linux") {
    tray.setContextMenu(menu);
  }
};

/**
 * 托盘常驻。
 *
 * 「壳开着就算在线」靠它成立：窗口关掉之后进程还在，定时器和发件箱照常跑，
 * 通知还能弹出来。没有它，Windows 和 Linux 上关窗就等于退出。
 *
 * 图标用 `setTemplateImage`，菜单栏才能在深色和浅色之间自动反色。
 */
export const createTray = (options: TrayOptions): Tray => {
  const image = nativeImage.createFromPath(options.iconPath);

  if (image.isEmpty()) {
    options.log(`tray icon is missing or unreadable: ${options.iconPath}`);
  }

  image.setTemplateImage(true);

  const tray = new Tray(image);
  tray.setToolTip(app.getName());
  setMenu(tray, options);

  if (process.platform !== "linux") {
    tray.on("click", () => {
      states.get(tray)?.actions.onOpen();
    });

    tray.on("right-click", () => {
      const state = states.get(tray);

      if (state !== undefined) {
        tray.popUpContextMenu(state.menu);
      }
    });
  }

  return tray;
};

/**
 * 重画托盘菜单。
 *
 * 菜单一旦建好，里面的文案就固定了；换语言只能重建一份。左右键的分工不变：
 * 左键开应用，右键弹这份新菜单。
 */
export const updateTrayMenu = (tray: Tray, actions: TrayActions): void => {
  setMenu(tray, actions);
};
