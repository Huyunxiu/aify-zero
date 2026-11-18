import type { AgentTurn } from "@workspace/agent-client";

/** 通知正文的上限；再长就会被系统截断，截在哪里不如自己定。 */
const BODY_LIMIT = 120;

/**
 * 从回合里取通知正文：最后一段有内容的文本。
 *
 * 取最后一段而不是拼接全部：一次运行可能先写一段过程说明，再写结论；通知该
 * 带的是结论。空白折成单个空格——通知是单行，换行会变成空格或被吃掉。
 *
 * @param turn - 落定的回合。
 * @returns 截断后的正文；回合里没有文本时是空串。
 */
export const notificationBody = (turn?: unknown): string => {
  const content = (turn as AgentTurn | null | undefined)?.content;

  if (!Array.isArray(content)) {
    return "";
  }

  for (const step of [...content].toReversed()) {
    if (step?.type !== "assistant" || !Array.isArray(step.content)) {
      continue;
    }

    for (const part of [...step.content].toReversed()) {
      if (part?.type !== "text" || typeof part.text !== "string") {
        continue;
      }

      const text = part.text.replaceAll(/\s+/g, " ").trim();

      if (text !== "") {
        return text.length <= BODY_LIMIT
          ? text
          : `${text.slice(0, BODY_LIMIT - 1)}…`;
      }
    }
  }

  return "";
};
