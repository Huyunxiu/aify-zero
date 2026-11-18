import { publicProcedure } from "../../index";
import { outboxDispatcher } from "../../runtime";

/**
 * 投递器的只读状态。
 *
 * 和 `GET /timer/state` 平级，各有各的对象：扫描循环、订阅、库里还等着几行，
 * 这三件事要能分别回答。`lastScanAt` 是 null 说明循环没在跑；`subscribed` 是
 * false 说明桌面没连上来——那时候结果再多也弹不出来；`pending` 一直在涨说明
 * 前面两条其中之一成立。
 *
 * 它只读：投不投、投给谁，都由投递器自己决定。
 */
export const getOutboxState = publicProcedure
  .route({ method: "GET", path: "/outbox/state" })
  .handler(() => outboxDispatcher.state());

export const outbox = { getOutboxState };
