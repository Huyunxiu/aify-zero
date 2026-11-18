/**
 * 收帧这边的一句话：帧数据 → 文本。
 *
 * `ws` 交过来的 `data` 可能是 Buffer、ArrayBuffer，也可能是一串 Buffer（分片
 * 帧）。服务端、桌面主进程和端到端用例都要这一句，各写一遍就会漂。
 */

/**
 * 把一段收到的帧数据解成文本。
 *
 * @param data - `message` 事件给的 `data`；已经是字符串时原样返回。
 * @returns UTF-8 文本。
 */
export const frameText = (data: unknown): string => {
  if (typeof data === "string") {
    return data;
  }

  if (Array.isArray(data)) {
    return Buffer.concat(data as Uint8Array[]).toString("utf-8");
  }

  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf-8");
  }

  return Buffer.from(data as Uint8Array).toString("utf-8");
};
