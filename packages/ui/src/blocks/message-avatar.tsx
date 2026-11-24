import type { BotSummary } from "@workspace/agent-client";
import { BotIcon } from "lucide-react";

import { Avatar, AvatarFallback } from "../components/avatar";
import { BotAvatar } from "../components/bot-avatar";

/**
 * The user's face: one letter.
 *
 * It uses the same fallback a Bot without an image uses, so the two read as two
 * identities rather than as two different drawings.
 */
export const UserAvatar = () => (
  <Avatar className="mt-0.5" size="sm">
    <AvatarFallback aria-label="User">U</AvatarFallback>
  </Avatar>
);

/**
 * The assistant's face is the face of the Bot that said it.
 *
 * Until the Bot query answers, the row keeps a neutral glyph instead of dropping the
 * slot: a missing avatar would shift every line of the transcript by its width.
 */
export const AssistantAvatar = ({
  bot,
}: {
  readonly bot: BotSummary | null | undefined;
}) => {
  if (!bot) {
    return (
      <Avatar className="mt-0.5" size="sm">
        <AvatarFallback aria-label="Assistant">
          <BotIcon />
        </AvatarFallback>
      </Avatar>
    );
  }

  return (
    <BotAvatar
      avatarPath={bot.avatarPath}
      botId={bot.id}
      className="mt-0.5"
      name={bot.name}
      size="sm"
      version={bot.updatedAt}
    />
  );
};
