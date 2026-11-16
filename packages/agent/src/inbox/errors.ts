/**
 * 领取一条已经不在收件箱里的待办项。
 *
 * 常见于两个调用者同时领取同一条：只有一个能原子领走，另一个拿到这个错误后
 * 刷新列表并移除该项。
 */
export class InboxItemNotFoundError extends Error {
  override readonly name = "InboxItemNotFoundError";
  readonly id: string;

  constructor(id: string) {
    super(`Inbox item ${id} was not found.`);
    this.id = id;
  }
}
