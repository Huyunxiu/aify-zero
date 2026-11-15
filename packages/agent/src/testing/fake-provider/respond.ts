import type { ServerResponse } from "node:http";

/** 响应头里不该跟着转发或回放的头：由当前这条连接决定。 */
const HOP_BY_HOP = new Set([
  "connection",
  "content-length",
  "keep-alive",
  "transfer-encoding",
]);

/**
 * 过滤掉 hop-by-hop 头。
 *
 * 转发和回放共用这一份：两边口径不一致时，回放出来的响应会和真流不一样，而且
 * 没人会想到去查。
 */
export function copyHeaders(
  headers: Headers | Readonly<Record<string, string>>
): Record<string, string> {
  const entries =
    headers instanceof Headers
      ? [...headers.entries()]
      : Object.entries(headers);

  return Object.fromEntries(
    entries.filter(([name]) => !HOP_BY_HOP.has(name.toLowerCase()))
  );
}

/** 统一的错误信封：三个出口都写这一份。 */
export function sendError(
  response: ServerResponse,
  status: number,
  message: string
): void {
  if (response.headersSent) {
    response.destroy();
    return;
  }

  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: { message } }));
}
