import type { ModelRef } from "@workspace/shared/model";

import type { AgentUserTurn } from "./types";
import { JOB_NOTICE_STEP_SOURCE, SUBAGENT_NOTICE_STEP_SOURCE } from "./types";

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

/**
 * 一句写给人或父代理看的话专用的待办项种类。
 *
 * 用户在界面上写的那条，和父代理递给子代理的那句，都记成这一种：它们都是
 * 「有人要说的话」，只是写信的人不同。
 */
export const USER_MESSAGE_INBOX_KIND = "user-message";

/** 完成通知专用的待办项种类。 */
export const JOB_NOTICE_INBOX_KIND = "job-notice";

/** 定时器到点专用的待办项种类。 */
export const TIMER_INBOX_KIND = "timer";

/** 子代理落定专用的待办项种类。 */
export const SUBAGENT_NOTICE_INBOX_KIND = "subagent-settled";

/**
 * 待办项的种类。
 *
 * 用户消息由人写；`job-notice` 是后台任务结算后系统投递的完成通知，
 * `timer` 是定时器到点后调度器投递的待办项。后两种都不是用户输入，也不
 * 参与「用户插话」判定。
 */
export type InboxKind =
  | typeof USER_MESSAGE_INBOX_KIND
  | typeof JOB_NOTICE_INBOX_KIND
  | typeof TIMER_INBOX_KIND
  | typeof SUBAGENT_NOTICE_INBOX_KIND;

/**
 * 一条完成通知的形状：投进收件箱时记的种类，和它变成回合后 step 上记的来源。
 *
 * 两者一起给，因为它们是同一件事的两个位置：一条通知在库里是一种待办项，
 * 到了 transcript 里就是一种步骤来源。分开给会让它们漂开——投的是子代理，
 * 回合却标成后台任务。
 */
export type NoticeForm = {
  readonly kind:
    | typeof JOB_NOTICE_INBOX_KIND
    | typeof SUBAGENT_NOTICE_INBOX_KIND;
  readonly source:
    | typeof JOB_NOTICE_STEP_SOURCE
    | typeof SUBAGENT_NOTICE_STEP_SOURCE;
};

/** 后台任务结算后投的那条通知。 */
export const JOB_NOTICE: NoticeForm = {
  kind: JOB_NOTICE_INBOX_KIND,
  source: JOB_NOTICE_STEP_SOURCE,
};

/** 子代理落定后投的那条通知。 */
export const SUBAGENT_NOTICE: NoticeForm = {
  kind: SUBAGENT_NOTICE_INBOX_KIND,
  source: SUBAGENT_NOTICE_STEP_SOURCE,
};

/**
 * 这一种待办项是不是一条完成通知。
 *
 * 清掉重启后过期的通知时读它：通知指向的那件事已经不存在，而用户消息和定时器
 * 不是。
 * @param kind - 待办项的种类。
 * @returns 通知为 true。
 */
export const isNoticeInboxKind = (kind: InboxKind): boolean =>
  kind === JOB_NOTICE_INBOX_KIND || kind === SUBAGENT_NOTICE_INBOX_KIND;

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
