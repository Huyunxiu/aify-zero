/**
 * 工具结果摊成可读文本。
 *
 * `ToolOutput` 的 `output` 可以是字符串，也可以是结构化结果——`search-tools` 交回
 * 的就是一个对象。面板只认文本，所以对象在这里按 JSON 打；把对象直接交给 React
 * 会抛「Objects are not valid as a React child」。
 */
export function toolOutputText(envelope: unknown): string {
  const output =
    typeof envelope === "object" && envelope !== null && "output" in envelope
      ? (envelope as { output?: unknown }).output
      : undefined;

  if (typeof output === "string") {
    return output;
  }

  if (output === undefined || output === null) {
    return "";
  }

  // 函数和 symbol 会被 `JSON.stringify` 变成 undefined，那就没有什么可显示的。
  return JSON.stringify(output, null, 2) ?? "";
}
