import type { ModelRef } from "@workspace/shared/model";

import type { AgentUserTurn } from "./types";

/**
 * 一条待办项最早能在哪个边界交进去。
 *
 * - `step-boundary`：正在跑的回合可以在下一个模型步领走它；
 * - `run-boundary`：等下一次运行开始时再领。
 *
 * 它存的是入队时解析好的结果，不是发送者的偏好：客户端拿到的就是这个值，
 * 所以它能说清一条消息会被插进当前回合，还是排在后面。
 */
export type DeliverAt = "step-boundary" | "run-boundary";

/** 待办项的种类。今天只有用户消息；定时器到点和外部事件以后从这里加。 */
export type InboxKind = "user-message";

/** 起跑一条待办项所需的宿主配置。 */
export type InboxPayload = {
  model: ModelRef;
  modelEffort?: string;
  projectId?: string;
};

/**
 * 收件箱里的一行：已经到了、还没进入模型循环的东西。
 *
 * 它只在收件箱里存在；领取成功后，内容会写进 turn / step，这一行随即删除。
 * `seq` 是服务端自增序号，列表按它排序。
 */
export type InboxItem = {
  seq: number;
  id: string;
  sessionId: string;
  kind: InboxKind;
  /** 客户端幂等键；同一条消息重试不会重复入队。 */
  dedupeKey: string;
  deliverAt: DeliverAt;
  content: AgentUserTurn;
  payload: InboxPayload;
  createdAt: number;
};

/** 入队一条待办项需要提供的字段；id / seq / createdAt 由服务端生成。 */
export type EnqueueInboxInput = {
  sessionId: string;
  kind: InboxKind;
  dedupeKey: string;
  deliverAt: DeliverAt;
  content: AgentUserTurn;
  payload: InboxPayload;
};
