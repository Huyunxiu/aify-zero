/** 由当前连接决定、不跟着转发也不跟着回放的头。 */
const HOP_BY_HOP = new Set([
  "connection",
  "content-length",
  "keep-alive",
  "transfer-encoding",
]);

/**
 * 删掉这些头；代理与回放都要按自己这条连接重新分帧。
 *
 * 留着上游的 `content-length`，客户端收满那么多个字节就认为读完，不等本条连接
 * 的结束信号 —— 录制还来不及落盘，它已经去读文件了。
 */
export const withoutHopByHop = (
  headers: Readonly<Record<string, string>>
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(headers).filter(
      ([name]) => !HOP_BY_HOP.has(name.toLowerCase())
    )
  );
