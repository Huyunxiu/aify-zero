import { publicProcedure } from "../../index";
import { timerScheduler } from "../../runtime";

/**
 * 定时器扫描循环的只读状态。
 *
 * 和 `GET /runner/state` 平级，不是它的一个字段：扫描循环和运行器是两个对象，
 * 读的人要能分清「没到点」「扫描停了」「投了但会话没动」这三种故障。挂着的
 * 定时器数回答第一种，`lastScanAt` 回答第二种，`lastFired` 回答第三种。
 */
export const getTimerState = publicProcedure
  .route({ method: "GET", path: "/timer/state" })
  .handler(() => timerScheduler.state());

export const timer = { getTimerState };
