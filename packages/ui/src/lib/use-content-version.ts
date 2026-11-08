/**
 * 内容的版本号。
 *
 * `CodeView` 用 id 认条目、用 version 认内容变化：同一个 id 的内容变了，version
 * 必须跟着变，否则条目不会重画。而「内容变了没有」不用自己算——查询层在数据变化
 * 时给出新对象，没变时保留旧引用，所以「这段输入的身份换了」就是「内容换了」。
 *
 * 逐字符哈希是 O(内容长度)，这里只比较一次身份，是 O(1)，也不会撞。身份没变时
 * 版本不动；偶尔多涨一次（例如一次刷新拿到同样的字节）只会让条目多画一次，不会
 * 画错。
 */
import * as React from "react";

/**
 * 跟随输入身份变化的版本号。
 *
 * @param input - 内容的来源，通常是查询结果；换对象即视为内容变化。
 * @returns 从 0 开始、每次身份变化加一的版本号。
 */
export function useContentVersion(input: unknown): number {
  const seen = React.useRef(input);
  const version = React.useRef(0);

  if (!Object.is(seen.current, input)) {
    seen.current = input;
    version.current += 1;
  }

  return version.current;
}
