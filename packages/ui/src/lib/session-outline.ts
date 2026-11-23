import {
  isAgentFilePart,
  isAgentTextPart,
  isSystemStepSource,
} from "@workspace/agent-client";
import type {
  AgentAssistantTurn,
  AgentToolSet,
  AgentTurn,
  AgentUserTurn,
} from "@workspace/agent-client";

import type { Lang } from "../i18n";
import { formatShortDate } from "./relative-time";

/** 提问标签的截断长度。读屏名字要短，悬停卡片也会再限一行。 */
const LABEL_MAX = 48;

/**
 * 会话大纲的一节。
 *
 * 一节对应读者的**一次提问**，不是一条回合：提问后面的答复并入这一节，直到下一次
 * 提问才开出新的一节。完成通知和定时器也写成用户轮次，但它们不是提问，不单独成节。
 */
export type SessionOutlineSection = {
  /** 这一节跳到的用户轮次 id，也就是滚动锚点的 id。 */
  id: string;
  /**
   * 该轮次在全部用户轮次里的序号。
   *
   * 被跳过的系统轮次也占一个锚点，所以它不等于节的下标；活动标记要靠它判断当前
   * 锚点落在哪一节之后。
   */
  anchorIndex: number;
  /** 提问，压成一行。没有文字时用附件名或节号。 */
  label: string;
  /** 这一节都是顶层条目，横线用同一种粗细。 */
  level: 1;
  /** 这一节的答复预览，取末条答复里最后一个有文字的步骤。 */
  description?: string;
  /** 提问的时刻，按语言的写法。 */
  meta?: string;
};

type OutlineDraft = {
  id: string;
  anchorIndex: number;
  createdAt: number;
  turn: AgentUserTurn;
  answer?: AgentAssistantTurn<AgentToolSet>;
};

/**
 * 把会话记录压成大纲。
 *
 * 只读轮次和它们的时间，不读界面状态：同一份记录在任何时候都得到同一份大纲。
 * @param turns - 会话记录，按发生顺序。
 * @param now - 用来判断「今天」与「今年」的当前时刻。
 * @param lang - 决定钟点与日期的写法。
 * @returns 按提问顺序排列的各节。
 */
export function buildSessionOutline(
  turns: readonly AgentTurn<AgentToolSet>[],
  now: number,
  lang: Lang
): SessionOutlineSection[] {
  const drafts: OutlineDraft[] = [];
  let anchorIndex = 0;

  for (const turn of turns) {
    if (turn.type === "user") {
      const index = anchorIndex;
      anchorIndex += 1;

      if (isQuestion(turn)) {
        drafts.push({
          id: turn.id,
          anchorIndex: index,
          createdAt: turn.createdAt,
          turn,
        });
      }

      continue;
    }

    // 答复属于最近一次提问；中间夹着的系统轮次不切节，所以它不打断这条归属。
    if (turn.type === "assistant" && drafts.length > 0) {
      drafts.at(-1)!.answer = turn;
    }
  }

  return drafts.map((draft, index) => {
    const text = collapse(getQuestionText(draft.turn));

    return {
      id: draft.id,
      anchorIndex: draft.anchorIndex,
      label:
        text.length > 0
          ? truncate(text)
          : (getFirstFileName(draft.turn) ?? `#${index + 1}`),
      level: 1,
      description: getAnswerPreview(draft.answer),
      meta: formatOutlineTime(draft.createdAt, now, lang),
    };
  });
}

/**
 * 一次提问的时刻。
 *
 * 今天只写钟点；同一年写日期和钟点；跨年才带年份。日期与会话列表用同一套写法，
 * 不在这里另造一种。
 */
export function formatOutlineTime(at: number, now: number, lang: Lang): string {
  const clock = CLOCK_FORMATTERS[lang].format(new Date(at));

  if (isSameDay(at, now)) {
    return clock;
  }

  return DATE_TIME_JOINERS[lang](formatShortDate(at, now, lang), clock);
}

/** 完成通知和定时器也是用户轮次，但读者没有问过它们。 */
function isQuestion(turn: AgentUserTurn): boolean {
  return turn.content.every((step) => !isSystemStepSource(step.source));
}

function getQuestionText(turn: AgentUserTurn): string {
  const text: string[] = [];

  for (const step of turn.content) {
    for (const part of step.content) {
      if (isAgentTextPart(part)) {
        text.push(part.text);
      }
    }
  }

  return text.join(" ");
}

function getFirstFileName(turn: AgentUserTurn): string | undefined {
  for (const step of turn.content) {
    for (const part of step.content) {
      if (isAgentFilePart(part) && part.filename) {
        return part.filename;
      }
    }
  }

  return undefined;
}

/**
 * 末条答复里最后一个有文字的步骤。
 *
 * 一条答复里会先写「我先看看…」再调工具，最后才写结论；预览要的是结论，不是
 * 过程话。全无文字（还在跑、或只调了工具）时不占位。
 */
function getAnswerPreview(
  turn: AgentAssistantTurn<AgentToolSet> | undefined
): string | undefined {
  if (!turn) {
    return undefined;
  }

  for (let index = turn.content.length - 1; index >= 0; index -= 1) {
    const step = turn.content[index];

    if (step?.type !== "assistant") {
      continue;
    }

    const text = collapse(
      step.content
        .filter(isAgentTextPart)
        .map((part) => part.text)
        .join(" ")
    );

    if (text.length > 0) {
      return text;
    }
  }

  return undefined;
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function truncate(text: string): string {
  return text.length > LABEL_MAX ? `${text.slice(0, LABEL_MAX)}…` : text;
}

function isSameDay(at: number, now: number): boolean {
  const a = new Date(at);
  const b = new Date(now);

  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

const CLOCK_FORMATTERS: Record<Lang, Intl.DateTimeFormat> = {
  "en-US": new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
  }),
  "zh-CN": new Intl.DateTimeFormat("zh-CN", {
    hour: "numeric",
    minute: "2-digit",
  }),
};

const DATE_TIME_JOINERS: Record<Lang, (date: string, clock: string) => string> =
  {
    "en-US": (date, clock) => `${date}, ${clock}`,
    "zh-CN": (date, clock) => `${date} ${clock}`,
  };
