import type { BotDetail } from "@workspace/agent-client";
import type { client } from "@workspace/ui/lib/orpc";

export type BotUpdateInput = Omit<
  Parameters<typeof client.bot.update>[0],
  "botId"
>;

/** One Bot's settings: the loaded Bot, and the one channel that saves it. */
export type BotSettings = {
  bot: BotDetail;
  isSaving: boolean;
  onUpdate: (patch: BotUpdateInput) => Promise<void>;
};
