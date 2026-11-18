import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

/** 跑一条命令；成功返回 true。 */
const run = (command: string, args: readonly string[]): boolean => {
  try {
    execFileSync(command, args, { stdio: "ignore" });

    return true;
  } catch {
    return false;
  }
};

/**
 * macOS 只让带有效签名的应用发系统通知。
 *
 * `electron` 包在某些镜像里解出来的 `Electron.app` 带的是链接器签名：
 * `_CodeSignature` 缺失，`Info.plist` 也没有绑定。系统会用
 * `UNErrorDomain error 1` 拒收它的系统通知，而 `Notification.show()` 不抛
 * 错——屏幕上什么都不出现，应用还以为已经送达。
 *
 * Forge 的 `preStart` 钩子在每次 `electron-forge start` 之前调用它。其他
 * 平台直接跳过；重签失败只告警，不拦开发（应用本身还能跑，只是没有系统
 * 通知）。
 */
export const ensureElectronSignature = (): void => {
  if (process.platform !== "darwin") {
    return;
  }

  const require = createRequire(import.meta.url);
  // 在 Node 里，`electron` 包的默认导出是 Electron 可执行文件的路径。
  const electronBinary = require("electron") as string;
  const appBundle = path.join(electronBinary, "../../..");

  if (run("codesign", ["--verify", "--deep", "--strict", appBundle])) {
    return;
  }

  console.log(
    `[dev] Electron.app signature is invalid; re-signing ${appBundle}`
  );

  if (run("codesign", ["--force", "--deep", "--sign", "-", appBundle])) {
    console.log(
      "[dev] Electron.app re-signed; system notifications can work again"
    );
  } else {
    console.error(
      "[dev] failed to re-sign Electron.app; macOS will drop system notifications"
    );
  }
};
