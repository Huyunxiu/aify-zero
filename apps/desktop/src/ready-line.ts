/**
 * 解析 server 子进程 stdout 里的就绪行。
 *
 * 子进程的 stdout 同时承载普通日志和一行 `{"type":"ready","origin":...}`；
 * 只有后者才算握手成功。抽成纯函数，主进程和测试用同一套规则。
 */
export interface ServerReadyLine {
  readonly origin: string;
}

/**
 * @param line - stdout 的一整行（不含换行符）。
 * @returns 就绪事件；普通日志或格式不对时返回 undefined。
 */
export const parseServerReadyLine = (
  line: string
): ServerReadyLine | undefined => {
  // JSON 日志也可能存在，先按首字符快速排除；真正的判断在字段上，不能靠
  // 键顺序（`type` 不一定在第一个）。
  if (!line.startsWith("{")) {
    return undefined;
  }

  try {
    const value = JSON.parse(line) as { origin?: unknown; type?: unknown };

    if (value.type === "ready" && typeof value.origin === "string") {
      return { origin: value.origin };
    }
  } catch {
    // 半行、普通文本或非 JSON 日志：都不是就绪信号。
  }

  return undefined;
};
