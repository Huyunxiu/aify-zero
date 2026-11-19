import { TIMER_STEP_SOURCE } from "@workspace/agent-client";
import type { AgentUserTurn } from "@workspace/agent-client";

import { generateStepId, generateTurnId } from "../utils/id-util";
import { renderRecurrence } from "./recurrence";
import { DEFAULT_SCAN_INTERVAL_MS } from "./scheduler";
import type { FiredTimer, Timer } from "./types";

/** 一条定时器到点的通知正文；和完成通知一样自带来源，模型不必猜是谁在说话。 */
export type TimerNotice = {
  /** 投给模型的正文。 */
  text: string;
};

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const plural = (count: number, unit: string): string =>
  count === 1 ? `1 ${unit}` : `${count} ${unit}s`;

/**
 * 把一段时长写成给人看的说法。
 *
 * 它的用途只有一个：让模型判断这次跟进还成不成立。「三天前设的」和「五分钟
 * 前设的」是两件不同的事，而时间戳本身不会说话。
 * @param elapsedMs - 已经过去的毫秒数。
 * @returns 例如 `12 minutes`、`1 hour`、`3 days`。
 */
export const formatAge = (elapsedMs: number): string => {
  const elapsed = Math.max(0, elapsedMs);

  if (elapsed < MINUTE_MS) {
    return "less than a minute";
  }
  if (elapsed < HOUR_MS) {
    return plural(Math.floor(elapsed / MINUTE_MS), "minute");
  }
  if (elapsed < DAY_MS) {
    return plural(Math.floor(elapsed / HOUR_MS), "hour");
  }

  return plural(Math.floor(elapsed / DAY_MS), "day");
};

/**
 * 迟到的判定线：超过两个扫描间隔才值得写进正文。
 *
 * 正常迟到由扫描间隔决定（默认 60 秒），那点误差对模型没有信息量；停机之后补投
 * 的那种迟到要说出来，模型才判断得出这次唤醒还成不成立。
 */
const LATE_AFTER_MS = 2 * DEFAULT_SCAN_INTERVAL_MS;

/** 去掉结尾的句号，免得正文出现两个连着的句号。 */
const trimPeriod = (text: string): string => text.trim().replace(/\.+$/, "");

/** 跟进那条正文；和一期完全一致，模型已经按这个形状理解。 */
const followUpText = (timer: Timer, firedAt: number): string =>
  `timer ${timer.id} fired. You set it ${formatAge(
    firedAt - timer.createdAt
  )} ago: ${trimPeriod(timer.note)}. Continue the work it was set for.`;

/**
 * 日程那条正文：规则、下一次、迟到。
 *
 * 三样都要说。规则让模型认出这是周期；下一次让它知道还会再来，不会把这次当成
 * 一次性跟进做完就收工；迟到只在明显迟到时出现，正常误差不占正文。
 */
const scheduleText = (
  timer: Timer,
  firedAt: number,
  nextDueAt: number | null
): string => {
  const rule =
    timer.recurrence === null ? "" : renderRecurrence(timer.recurrence);
  const lateMs = firedAt - timer.dueAt;
  const parts = [
    `schedule ${timer.id} fired (${rule}).`,
    nextDueAt === null ? "" : `Next: in ${formatAge(nextDueAt - firedAt)}.`,
    lateMs > LATE_AFTER_MS ? `It was due ${formatAge(lateMs)} ago.` : "",
    `You set it ${formatAge(firedAt - timer.createdAt)} ago: ${trimPeriod(
      timer.note
    )}.`,
    "Continue the work it was set for.",
  ];

  return parts.filter((part) => part !== "").join(" ");
};

/**
 * 组一条到点通知。
 *
 * 正文自己说明它不是用户说的话：只靠 step 上的 `source` 标记不够，模型读到的
 * 是文本。跟进和日程是两种正文：日程必须说出「下一次」，否则模型会把一次触发
 * 当成一次性跟进。
 * @param fired - 到点的那一条，连同它被认定到点的时刻。
 * @returns 通知正文。
 */
export const composeTimerNotice = (fired: FiredTimer): TimerNotice => {
  const { firedAt, nextDueAt, recurrence } = fired;

  return {
    text:
      recurrence === null
        ? followUpText(fired, firedAt)
        : scheduleText(fired, firedAt, nextDueAt),
  };
};

/**
 * 把一条到点的定时器组成交给收件箱的 user 回合。
 *
 * 形状和用户消息、完成通知一致：模型不需要第二种消息形状。step 上带
 * `source`，界面和「用户插话」判定据此知道它不是用户输入。
 * @param fired - 到点的那一条，连同它被认定到点的时刻。
 * @returns 写进收件箱的回合。
 */
export const composeTimerTurn = (fired: FiredTimer): AgentUserTurn => {
  const { firedAt } = fired;
  const { text } = composeTimerNotice(fired);

  return {
    id: generateTurnId(),
    type: "user",
    createdAt: firedAt,
    status: "done",
    content: [
      {
        id: generateStepId(),
        type: "user",
        createdAt: firedAt,
        status: "done",
        source: TIMER_STEP_SOURCE,
        content: [{ type: "text", text, createdAt: firedAt }],
      },
    ],
  };
};
