import { logger } from "@workspace/shared/logger";

/**
 * 录制带控制面的地址。设了它，一次真正的插话会让播放器接管。
 *
 * 例如 `AIFY_TAPE_CONTROL=http://127.0.0.1:4032`。没设就是空操作，生产路径
 * 不受影响。
 */
const CONTROL_ENV = "AIFY_TAPE_CONTROL";

/**
 * 告诉播放器：时间轴在这一点分叉。
 *
 * 只在「待办项真的会被插进当前回合」时调用——空闲时的消息、等待审批时的消息都
 * 落在运行边界，不该把正在播的响应截断。
 *
 * 失败只记一条日志：录制带是调试设施，它连不上不该挡住用户的消息。
 */
export const notifyTapeTakeover = (): void => {
  const target = process.env[CONTROL_ENV];

  if (target === undefined || target === "") {
    return;
  }

  void fetch(`${target.replace(/\/$/, "")}/__tape/takeover`, {
    method: "POST",
  }).catch((error: unknown) => {
    logger.warn(
      `[tape] control unreachable: ${error instanceof Error ? error.message : String(error)}`
    );
  });
};
