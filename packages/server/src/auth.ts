/**
 * Bearer token 校验。
 *
 * 服务端没有 cookie / session，所有请求都必须带上 `Authorization: Bearer
 * <token>`。自定义头还会让浏览器请求触发 CORS 预检，而服务端没有 CORS
 * 中间件，所以跨站页面无法借本机浏览器调用 API。
 */
import {
  extractBearerToken,
  resolveApiToken,
  tokensEqual,
} from "@workspace/shared/api-token";
import type { MiddlewareHandler } from "hono";

/**
 * @param token - 每次请求解析一次令牌；测试注入固定值，运行期走
 * `resolveApiToken()`（内部有缓存）。
 */
export const bearerAuth =
  (token: () => string = resolveApiToken): MiddlewareHandler =>
  async (c, next) => {
    const provided = extractBearerToken(c.req.header("authorization"));

    if (!tokensEqual(token(), provided)) {
      c.header("www-authenticate", 'Bearer realm="aify"');
      return c.json({ error: "unauthorized" }, 401);
    }

    await next();
  };
