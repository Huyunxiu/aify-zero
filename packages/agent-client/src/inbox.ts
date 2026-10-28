import type { AgentUserTurn } from "./types";

/**
 * 一条待发送消息的投递位置。
 *
 * - `next-step`：回合运行中补的引导消息，下一个模型步边界领取；
 * - `next-turn`：等当前回合结束后，作为新回合发送。
 */
export type InboxPlacement = "next-step" | "next-turn";

/** 发送一条排队消息所需的模型信息。 */
export type InboxPayload = {
  model: string;
  modelEffort?: string;
  projectId?: string;
};

/**
 * 一条尚未发送的消息。
 *
 * 它只在 Inbox 里存在；领取成功后，内容会写进 turn / step，这一行随即删除。
 * `seq` 是服务端自增序号，列表按它排序。
 */
export type InboxMessage = {
  seq: number;
  id: string;
  sessionId: string;
  /** 客户端幂等键；同一条消息重试不会重复入队。 */
  requestId: string;
  placement: InboxPlacement;
  content: AgentUserTurn;
  payload: InboxPayload;
  createdAt: number;
};

/** 入队一条消息需要提供的字段；id / seq / createdAt 由服务端生成。 */
export type EnqueueInboxInput = {
  sessionId: string;
  requestId: string;
  placement: InboxPlacement;
  content: AgentUserTurn;
  payload: InboxPayload;
};
