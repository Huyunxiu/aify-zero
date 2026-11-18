/**
 * 发件箱的入站一侧：一次落定要不要留一条记录。
 *
 * 这里只有「记一条」这一个动作。真正确认送达的是桌面：它弹出系统通知之后回
 * 一条回执。所以这个包不知道通知、不碰通道，也不决定什么时候取件。
 */
export type OutboxRecordInput = {
  /** 这条回复属于哪个会话。 */
  sessionId: string;
  /** 哪个回合；和会话 id 一起唯一确定一行。 */
  turnId: string;
};

/**
 * 发件箱的记录端口。
 *
 * 宿主实现它，运行器在运行落定时调用。写失败不该影响一次运行的落定——
 * 调用方按「尽力而为」处理。
 */
export interface OutboxRecorder {
  record(input: OutboxRecordInput): Promise<void>;
}
