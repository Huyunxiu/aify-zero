/**
 * 每个会话一把互斥锁，用来串行化不能交错的操作。
 *
 * 有两处需要它：手工压缩（读历史、摘要、写标记）和启动 turn（读 branch、
 * 构造 agent、注册 stream）。没有这把锁时，紧接着 `/compact` 发出的消息可能
 * 读到压缩前的 branch，拿着过期历史去跑。
 *
 * map 里保存每个会话队列的尾部。一个任务总是在前一个任务落定之后才执行——
 * 无论它是成功还是失败——所以一次失败不会把会话卡死。
 */
const tails = new Map<string, Promise<unknown>>();

export function withSessionLock<T>(
  sessionId: string,
  task: () => Promise<T>
): Promise<T> {
  const previous = tails.get(sessionId) ?? Promise.resolve();
  const run = previous.then(task, task);
  const tail = run.catch(() => null);
  tails.set(sessionId, tail);
  void tail.finally(() => {
    if (tails.get(sessionId) === tail) {
      tails.delete(sessionId);
    }
  });
  return run;
}
