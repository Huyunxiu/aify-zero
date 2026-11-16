import { publicProcedure } from "../../index";
import { sessionRunner } from "../../session/runner";

/**
 * 运行器的只读状态。
 *
 * 队列深度不在这里：一条会话的待办项由 `GET /sessions/{id}/inbox` 给。这里
 * 回答另外两个问题：现在有哪几条运行在跑，哪些会话停下了、为什么。
 */
export const getRunnerState = publicProcedure
  .route({ method: "GET", path: "/runner/state" })
  .handler(() => sessionRunner().state());

export const runner = { getRunnerState };
