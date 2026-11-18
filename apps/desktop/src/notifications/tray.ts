import { app, Menu, nativeImage, Tray } from "electron";

export type TrayOptions = {
  /** 图标文件的绝对路径；开发期和打包后由调用方算好。 */
  iconPath: string;
  /** 点图标或菜单里的「打开」。 */
  onOpen: () => void;
  /** 菜单里的「退出」：它是唯一能真正结束应用的入口。 */
  onQuit: () => void;
  log: (message: string) => void;
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
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { click: options.onOpen, label: "打开 Aify Zero" },
      { type: "separator" },
      { click: options.onQuit, label: "退出" },
    ])
  );
  tray.on("click", options.onOpen);

  return tray;
};
