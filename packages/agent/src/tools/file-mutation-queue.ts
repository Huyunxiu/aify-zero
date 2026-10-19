import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

/** 每个文件一条串行队列；不同文件之间仍然可以并行。 */
const fileMutationQueues = new Map<string, Promise<void>>();
/** 串行化“读取队列 → 挂载新任务”这段注册过程，避免并发注册读到同一个队尾。 */
let registrationQueue = Promise.resolve();

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

/**
 * 队列按真实路径索引：软链接和 `..` 指向的同一个文件必须共用一条队列，
 * 否则两个看起来不同的路径仍会互相覆盖。
 */
async function getMutationQueueKey(filePath: string): Promise<string> {
  const resolvedPath = resolve(filePath);
  try {
    return await realpath(resolvedPath);
  } catch (error) {
    if (isMissingPathError(error)) {
      return resolvedPath;
    }
    throw error;
  }
}

/**
 * 串行执行针对同一个文件的修改操作。
 *
 * 读-改-写的工具（edit-file）如果并发执行，后写者会用旧内容覆盖前者的改动；
 * 这里保证同一文件的修改按提交顺序执行，不同文件互不阻塞。
 */
export async function withFileMutationQueue<T>(
  filePath: string,
  fn: () => Promise<T>
): Promise<T> {
  const registration = registrationQueue.then(async () => {
    const key = await getMutationQueueKey(filePath);
    const currentQueue = fileMutationQueues.get(key) ?? Promise.resolve();

    let releaseNext!: () => void;
    const nextQueue = new Promise<void>((_resolve) => {
      releaseNext = _resolve;
    });
    const chainedQueue = currentQueue.then(() => nextQueue);
    fileMutationQueues.set(key, chainedQueue);

    return { key, currentQueue, chainedQueue, releaseNext };
  });
  registrationQueue = registration.then(
    () => {
      // 注册成功，队列尾部已经更新，无需额外操作。
    },
    () => {
      // 注册失败也不能阻塞后续注册。
    }
  );

  const { key, currentQueue, chainedQueue, releaseNext } = await registration;
  await currentQueue;
  try {
    return await fn();
  } finally {
    releaseNext();
    // 队列里没有后来者时清掉条目，避免 Map 无限增长。
    if (fileMutationQueues.get(key) === chainedQueue) {
      fileMutationQueues.delete(key);
    }
  }
}
