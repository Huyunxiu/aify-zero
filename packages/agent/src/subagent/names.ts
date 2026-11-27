/**
 * 子代理名的形状与分配。
 *
 * 名字是父会话唯一持有的地址：模型只拿得到名字，拿不到会话 id。它以父会话为
 * 作用域——两个父会话可以各有一个 `AGENT-1`——并且一旦写进行就不再改变，也
 * 不再重用。序号往前走到空位为止，所以并发派生不会撞名：唯一索引拍板，撞了
 * 就重算。
 */

const NAME_PREFIX = "AGENT-";

/** The name for the n-th subagent of one parent session. */
export function formatSubagentName(n: number): string {
  if (!Number.isInteger(n) || n < 1) {
    throw new RangeError(`a subagent number starts at 1, got ${n}`);
  }

  return `${NAME_PREFIX}${n}`;
}

/**
 * The first free name under one parent session.
 *
 * A child written before names existed holds no name, so it competes for none of
 * them. A gap left by a delete is filled before a new number is made, because the
 * number carries nothing a reader should count on.
 */
export function nextSubagentName(used: readonly (string | null)[]): string {
  const taken = new Set(used.filter((name): name is string => name !== null));

  let n = 1;
  while (taken.has(formatSubagentName(n))) {
    n += 1;
  }

  return formatSubagentName(n);
}

/**
 * Fold what a model typed into the form the row holds.
 *
 * A name is matched by equality on an indexed column, so the fold happens to the
 * caller's string, never to the column.
 */
export function normalizeSubagentName(input: string): string {
  return input.trim().toUpperCase();
}
