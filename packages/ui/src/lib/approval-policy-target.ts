/**
 * 改策略要写到哪一行上。
 *
 * 会话已经有 id 时就是它。首页路由没有 id，但第一条消息落库之后行已经在了，
 * 那时改策略必须写到刚建出来的那一行，否则界面显示的和库里存的分叉，下一次
 * 运行还会按旧策略走。
 *
 * 返回 undefined 表示行还不存在：首次消息会把策略一起带上去，这里不发请求。
 */
export function approvalPolicyTarget(input: {
  sessionId: string | undefined;
  sessionKey: string;
  rowSaved: boolean;
}): string | undefined {
  return input.sessionId ?? (input.rowSaved ? input.sessionKey : undefined);
}
