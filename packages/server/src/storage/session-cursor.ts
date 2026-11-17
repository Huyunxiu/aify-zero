/**
 * 会话列表的游标。
 *
 * 列表按最后活动排序，排序键是 (updatedAt, id) 两列：`updatedAt` 会重复
 * （同一毫秒收尾的两个会话），单靠它翻页会在重复值上丢行或重行，所以带上
 * `id` 做决胜列。游标就把这两列原样编码，不用 id 单独充当游标——uuidv7 只
 * 保证按创建时刻有序，按最后活动排序时它不再是同一个序。
 */

/** 分隔符不能出现在 uuid 里，也不能出现在整数里，取 `|` 最省事。 */
const SEPARATOR = "|";

export type SessionCursor = { updatedAt: Date; id: string };

/** 把一行会话的排序键编成游标。 */
export function encodeSessionCursor(row: {
  updatedAt: Date;
  id: string;
}): string {
  return `${row.updatedAt.getTime()}${SEPARATOR}${row.id}`;
}

/**
 * 还原游标。形状不对就返回 `undefined`，调用方退回第一页。
 *
 * 游标是服务端自己发的，还原失败只可能是客户端篡改或版本不一致；那种情况下
 * 退回第一页比抛错好——抛错会让一个走错的请求把整个侧边栏变成错误态。
 */
export function parseSessionCursor(cursor: string): SessionCursor | undefined {
  const [rawUpdatedAt, id, ...rest] = cursor.split(SEPARATOR);

  // 空串也要挡住：`Number("")` 是 0，会被当成 1970 年的时间戳放过去。
  if (
    rest.length > 0 ||
    rawUpdatedAt === undefined ||
    rawUpdatedAt === "" ||
    id === undefined ||
    id === ""
  ) {
    return undefined;
  }

  const updatedAt = Number(rawUpdatedAt);

  if (!Number.isFinite(updatedAt)) {
    return undefined;
  }

  return { updatedAt: new Date(updatedAt), id };
}
