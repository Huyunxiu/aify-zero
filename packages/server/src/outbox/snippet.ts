import type { AgentToolSet } from "@workspace/agent";
import { isAgentTextPart } from "@workspace/agent-client";
import type { AgentTurn } from "@workspace/agent-client";

/** 通知正文的上限；再长就会被系统截断，截在哪里不如自己定。 */
const BODY_LIMIT = 120;

/**
 * 从回合里取投递正文：最后一段有内容的文本。
 *
 * 取最后一段而不是拼接全部：一次运行可能先写一段过程说明，再写结论；通知该
 * 带的是结论。空白折成单个空格——通知是单行，换行会变成空格或被吃掉。
 *
 * @param turn - 落定的回合；不是 assistant 回合、或没有文本时返回空串。
 * @returns 截断后的正文。
 */
export const deliveryBody = (turn?: AgentTurn<AgentToolSet> | null): string => {
  if (turn?.type !== "assistant") {
    return "";
  }

  for (const step of [...turn.content].toReversed()) {
    if (step.type !== "assistant") {
      continue;
    }

    for (const part of [...step.content].toReversed()) {
      if (!isAgentTextPart(part)) {
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
