import { APP_SCHEME } from "@workspace/shared/app-url";
import { protocol } from "electron";

/**
 * 注册应用协议。必须在 `app.whenReady()` 之前调用一次，否则 Chromium
 * 不会把它当作标准源，`localStorage`、history 和相对 URL 都会失效。
 */
export const registerAppScheme = (): void => {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
        codeCache: true,
      },
    },
  ]);
};
