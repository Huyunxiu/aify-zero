import { publicProcedure } from "../../index";
import { timerScheduler } from "../../runtime";
import { resolveTimeZone } from "../settings/settings.service";

/**
 * 定时器扫描循环的只读状态。
 *
 * 和 `GET /runner/state` 平级，不是它的一个字段：扫描循环和运行器是两个对象，
 * 读的人要能分清「没到点」「扫描停了」「投了但会话没动」这三种故障。挂着的
 * 定时器数回答第一种，`lastScanAt` 回答第二种，`lastFired` 回答第三种。
 *
 * 还回一个生效时区：日历规则缺省就按它写。宿主跑在 UTC 而用户不在时，这个数
 * 是唯一能让错误显形的地方。
 */
export const getTimerState = publicProcedure
  .route({ method: "GET", path: "/timer/state" })
  .handler(async () => ({
    ...(await timerScheduler.state()),
    timeZone: await resolveTimeZone(),
  }));

export const timer = { getTimerState };
