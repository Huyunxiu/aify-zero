const OVERFLOW_PATTERNS = [
  /context (?:length|window)/i,
  /maximum context/i,
  /too many tokens/i,
  /prompt is too long/i,
  /context_length_exceeded/i,
  /reduce the length of the messages/i,
  /exceeds? the (?:model'?s )?context/i,
];

/**
 * 判断一次 provider 失败是否是上下文窗口超限。
 *
 * OpenAI-compatible provider 的措辞和状态码并不统一，所以这里读消息文本和
 * 响应体，而不是只认某个状态码。误判的代价只是多尝试一次压缩，因此匹配刻意放宽。
 */
export function isContextOverflowError(error: unknown): boolean {
  if (error === null || error === undefined) {
    return false;
  }

  const texts: string[] = [];
  if (error instanceof Error) {
    texts.push(error.message);
  } else if (typeof error === "string") {
    texts.push(error);
  } else {
    texts.push(JSON.stringify(error) ?? "unknown error");
  }

  const candidate = error as {
    responseBody?: unknown;
    data?: unknown;
    cause?: unknown;
  };
  if (typeof candidate.responseBody === "string") {
    texts.push(candidate.responseBody);
  }
  if (candidate.data !== undefined) {
    try {
      texts.push(JSON.stringify(candidate.data));
    } catch {
      // 无法序列化的负载提供不了信息，直接跳过。
    }
  }
  if (candidate.cause instanceof Error) {
    texts.push(candidate.cause.message);
  }

  const text = texts.join(" ");
  return OVERFLOW_PATTERNS.some((pattern) => pattern.test(text));
}
