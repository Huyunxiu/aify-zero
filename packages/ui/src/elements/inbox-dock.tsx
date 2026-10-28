import type { AgentUserTurn, InboxMessage } from "@workspace/agent-client";
import { isAgentTextPart } from "@workspace/agent-client";
import { SendIcon, XIcon } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Badge } from "../components/badge";
import { Button } from "../components/button";

export type InboxDockProps = {
  messages: InboxMessage[];
  /** 回合运行中：不能开始下一条，但仍可移除队列项。 */
  busy: boolean;
  onSend: () => void;
  onCancel: (messageId: string) => void;
  onClear: () => void;
};

const messageText = (turn: AgentUserTurn): string =>
  turn.content
    .flatMap((step) => step.content)
    .filter(isAgentTextPart)
    .map((part) => part.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * 待发送消息的队列条。
 *
 * 放在 composer 上方：用户能看到还有几条、各自是引导还是排队，并能立即发送
 * 或移除。它只呈现服务端队列；真正发送仍由 composer 的 drain 负责。
 */
export const InboxDock = ({
  messages,
  busy,
  onSend,
  onCancel,
  onClear,
}: InboxDockProps) => {
  const { t } = useTranslation();

  if (messages.length === 0) {
    return null;
  }

  return (
    <div className="mb-2 rounded-xl border bg-card/60 px-2 py-2">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-muted-foreground text-xs">
          {t("inbox.title", { count: messages.length })}
        </span>
        <div className="flex items-center gap-1">
          {messages.length > 1 && (
            <Button onClick={onClear} size="xs" variant="ghost">
              {t("inbox.clear")}
            </Button>
          )}
          <Button
            disabled={busy}
            onClick={onSend}
            size="xs"
            variant="secondary"
          >
            <SendIcon className="size-3.5" />
            {t("inbox.sendNow")}
          </Button>
        </div>
      </div>
      <ul className="flex max-h-36 flex-col gap-1 overflow-y-auto">
        {messages.map((message) => (
          <li className="flex items-center gap-2" key={message.id}>
            <Badge className="shrink-0" variant="secondary">
              {message.placement === "next-step"
                ? t("inbox.steering")
                : t("inbox.queued")}
            </Badge>
            <span className="min-w-0 flex-1 truncate text-sm">
              {messageText(message.content) || t("inbox.empty")}
            </span>
            <Button
              aria-label={t("inbox.remove")}
              onClick={() => onCancel(message.id)}
              size="icon-xs"
              variant="ghost"
            >
              <XIcon className="size-3.5" />
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
};
