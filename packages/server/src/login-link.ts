/**
 * 登录链接：怎么签发，以及页面该在哪个源上打开。
 *
 * 启动时和“给另一台设备生成链接”走同一段代码，两条路的结果必须一样。
 */
import {
  buildSignInUrl,
  resolveDevWebOrigin,
  resolvePublicOrigin,
  resolveWebOrigin,
} from "@workspace/shared/auth-session";
import type { AuthEnv } from "@workspace/shared/auth-session";

import type { AuthStore } from "./auth-store";

/** 探测开发服务器的超时；连不上时立刻失败，不会拖慢启动。 */
const DEV_SERVER_PROBE_TIMEOUT_MS = 300;

/**
 * 该端口上是不是跑着一个 Vite 开发服务器。
 *
 * 只问一个 Vite 独有的端点：root 返回 200 的普通 HTTP 服务太多了，分不出来。
 * 探到就说明页面在那边；探不到就说明页面由这个进程托管。
 *
 * @param origin - 开发服务器的源。
 */
const hasDevServer = async (origin: string): Promise<boolean> => {
  try {
    const response = await fetch(new URL("/@vite/client", origin), {
      signal: AbortSignal.timeout(DEV_SERVER_PROBE_TIMEOUT_MS),
    });

    return response.ok;
  } catch {
    return false;
  }
};

/**
 * 登录换完 cookie 之后要去的 web 源。
 *
 * 显式配置优先。否则看开发服务器在不在：在就跳过去，否则跳 server 自己。
 * 只依赖“谁在跑”，不依赖 `apps/web/dist` 是否存在——构建过的仓库里那个目录
 * 一直在，用它判断会把开发期的链接指到一份静态旧页面上。
 *
 * @param apiOrigin - server 的源。
 * @param env - 环境变量。
 */
export const resolveLoginWebOrigin = async (
  apiOrigin: string,
  env: AuthEnv = process.env
): Promise<string> => {
  const configured = resolveWebOrigin(env);

  if (configured !== undefined) {
    return configured;
  }

  // 远程部署一律同源；只有本机才需要找开发服务器。
  if (resolvePublicOrigin(env) !== undefined) {
    return apiOrigin;
  }

  const devOrigin = resolveDevWebOrigin(env);

  return (await hasDevServer(devOrigin)) ? devOrigin : apiOrigin;
};

/**
 * 给一个操作者签发登录链接。
 *
 * @param authStore - 登录态存储。
 * @param userId - 链接为谁签发。
 * @param webOrigin - web 文档的源，链接落在它上面。
 */
export const issueLoginLink = async ({
  authStore,
  userId,
  webOrigin,
}: {
  readonly authStore: AuthStore;
  readonly userId: string;
  readonly webOrigin: string;
}): Promise<{ url: string }> => {
  const ticket = await authStore.createLoginTicket(userId);

  return { url: buildSignInUrl({ ticket: ticket.token, webOrigin }) };
};
