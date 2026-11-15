/**
 * 本机 API server 的“可以服务请求”消息。
 *
 * server 跑在 Electron 的 `utilityProcess` 里时，父进程只能从子进程拿到监听
 * 地址：端口默认由系统分配，启动前没人知道落在哪。这条消息就是唯一通道，
 * 走 `process.parentPort`，不混进 stdout 的日志流。
 *
 * 独立启动（`vp run dev:server`、打包的独立 server）没有 `parentPort`，
 * 也就没有这条消息；那里的消费者是人，看的是打印出来的监听行。
 */
export interface ServerReadyMessage {
  /** 实际监听地址，例如 `http://127.0.0.1:54321`。 */
  readonly origin: string;
  readonly type: typeof SERVER_READY_TYPE;
}

/** 消息类型标记。父进程用它把就绪消息和别的消息区分开。 */
export const SERVER_READY_TYPE = "ready";

/** Electron 的 `utilityProcess` 子进程才有这个通道；独立启动时没有。 */
interface ParentPort {
  postMessage: (message: unknown) => void;
}

/**
 * 造一条就绪消息。
 *
 * @param origin - 实际监听地址。
 * @returns 可以交给 `parentPort.postMessage` 的值。
 */
export const createServerReadyMessage = (
  origin: string
): ServerReadyMessage => ({
  origin,
  type: SERVER_READY_TYPE,
});

/**
 * 把就绪消息交给父进程。没有通道时什么也不做。
 *
 * 判据是通道本身在不在，不是环境变量：独立启动的进程天然没有它，不需要
 * 任何开关。`parentPort` 不在 Node 的类型里，所以只在这里收窄一次。
 *
 * @param origin - 实际监听地址。
 */
export const postServerReadyMessage = (origin: string): void => {
  const host = process as unknown as { parentPort?: ParentPort };

  // `parentPort.postMessage` 不是 `window.postMessage`：没有 targetOrigin。
  // oxlint-disable-next-line unicorn/require-post-message-target-origin
  host.parentPort?.postMessage(createServerReadyMessage(origin));
};

/**
 * 判断一条 `parentPort` 消息是不是就绪消息。
 *
 * @param value - 收到的任意消息。
 * @returns 是就绪消息时返回 true，并把类型收窄。
 */
export const isServerReadyMessage = (
  value: unknown
): value is ServerReadyMessage => {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as { origin?: unknown; type?: unknown };

  // 空 origin 在这里就挡掉：放过去只会在 `normalizeServerOrigin` 里更晚地
  // 报一个更难读的错。
  return (
    candidate.type === SERVER_READY_TYPE &&
    typeof candidate.origin === "string" &&
    candidate.origin !== ""
  );
};
