import { app, Menu, nativeImage, Tray } from "electron";

import { t } from "../i18n";

/** 托盘菜单的两件事；语言换了要重画菜单，所以动作单独给出。 */
export type TrayActions = {
  /** 点图标或菜单里的「打开」。 */
  onOpen: () => void;
  /** 菜单里的「退出」：它是唯一能真正结束应用的入口。 */
  onQuit: () => void;
};

export type TrayOptions = TrayActions & {
  /** 图标文件的绝对路径；开发期和打包后由调用方算好。 */
  iconPath: string;
  log: (message: string) => void;
};

const buildMenu = (actions: TrayActions): Menu =>
  Menu.buildFromTemplate([
    { click: actions.onOpen, label: t("tray.open") },
    { type: "separator" },
    { click: actions.onQuit, label: t("tray.quit") },
  ]);

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
  tray.setContextMenu(buildMenu(options));
  tray.on("click", options.onOpen);

  return tray;
};

/**
 * 重画托盘菜单。
 *
 * 菜单一旦建好，里面的文案就固定了；换语言只能重建一份，`setContextMenu`
 * 会替换掉旧的。
 */
export const updateTrayMenu = (tray: Tray, actions: TrayActions): void => {
  tray.setContextMenu(buildMenu(actions));
};
