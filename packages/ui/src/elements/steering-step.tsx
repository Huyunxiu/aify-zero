import type { AgentSteeringStep } from "@workspace/agent-client";
import { useTranslation } from "react-i18next";

import { Bubble, BubbleContent } from "../components/bubble";
import { UserMessageAttachments, UserMessageText } from "./user-message";

/**
 * 回合运行中插入的一条引导消息。
 *
 * 它渲染在 assistant turn 的步骤链里，而不是成为新的顶层 user turn。右对齐
 * 的气泡保留“这是用户说的”这一层意思；位置说明它插在两次 assistant step
 * 之间。
 */
export const SteeringStep = ({ step }: { step: AgentSteeringStep }) => {
  const { t } = useTranslation();

  return (
    <div
      aria-label={t("steering.marker")}
      className="flex w-full justify-end py-1"
      data-steering="true"
      role="note"
    >
      <Bubble align="end" className="max-w-[85%]" variant="muted">
        <BubbleContent>
          <div className="flex flex-col gap-2">
            <UserMessageAttachments parts={step.content} />
            <UserMessageText parts={step.content} />
          </div>
        </BubbleContent>
      </Bubble>
    </div>
  );
};
