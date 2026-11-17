import { TIMER_STEP_SOURCE } from "@workspace/agent-client";
import type { AgentUserTurn } from "@workspace/agent-client";

import { generateStepId, generateTurnId } from "../utils/id-util";
import type { Timer } from "./types";

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

/** 去掉结尾的句号，免得正文出现两个连着的句号。 */
const trimPeriod = (text: string): string => text.trim().replace(/\.+$/, "");

/**
 * 组一条到点通知。
 *
 * 正文自己说明它不是用户说的话：只靠 step 上的 `source` 标记不够，模型读到的
 * 是文本。
 * @param input.timer - 到点的定时器。
 * @param input.firedAt - 这次扫描认定它到点的时刻。
 * @returns 通知正文。
 */
export const composeTimerNotice = ({
  timer,
  firedAt,
}: {
  timer: Timer;
  firedAt: number;
}): TimerNotice => ({
  text: `timer ${timer.id} fired. You set it ${formatAge(
    firedAt - timer.createdAt
  )} ago: ${trimPeriod(timer.note)}. Continue the work it was set for.`,
});

/**
 * 把一条到点的定时器组成交给收件箱的用户回合。
 *
 * 形状和用户消息、完成通知一致：模型不需要第二种消息形状。step 上带
 * `source`，界面和「用户插话」判定据此知道它不是用户输入。
 * @param input.timer - 到点的定时器。
 * @param input.firedAt - 这次扫描认定它到点的时刻。
 * @returns 写进收件箱的回合。
 */
export const composeTimerTurn = ({
  timer,
  firedAt,
}: {
  timer: Timer;
  firedAt: number;
}): AgentUserTurn => {
  const { text } = composeTimerNotice({ timer, firedAt });

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
