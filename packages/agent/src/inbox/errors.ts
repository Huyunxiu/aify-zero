/**
 * 领取一条已经不在 Inbox 里的消息。
 *
 * 常见于两个客户端同时发送同一条排队消息：只有一个能原子认领，另一个拿到
 * 这个错误后刷新列表并移除该项。
 */
export class InboxMessageNotFoundError extends Error {
  override readonly name = "InboxMessageNotFoundError";
  readonly id: string;

  constructor(id: string) {
    super(`Inbox message ${id} was not found.`);
    this.id = id;
  }
}
