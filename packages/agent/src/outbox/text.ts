import { isAgentTextPart } from "@workspace/agent-client";
import type { AgentTurn } from "@workspace/agent-client";

import type { AgentToolSet } from "../types";

/**
 * 这个回合有没有说得出的话。
 *
 * 一次运行可以以 `done` 结束却只有工具调用、没有一段文本——模型做完了事，
 * 但没写回复。没有正文的通知只会教人忽略通知，所以这种回合不进发件箱。
 *
 * 空白也算没有：全是空格或换行的文本在界面上不占位置。
 *
 * @param turn - 落定的回合；不是 assistant 回合时为 `false`。
 */
export const hasVisibleText = (turn?: AgentTurn<AgentToolSet>): boolean => {
  if (turn?.type !== "assistant") {
    return false;
  }

  return turn.content.some(
    (step) =>
      step.type === "assistant" &&
      step.content.some(
        (part) => isAgentTextPart(part) && part.text.trim() !== ""
      )
  );
};
