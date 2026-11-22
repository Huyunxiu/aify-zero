import { Minimize2Icon } from "lucide-react";

import {
  Frame,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "../../components/frame";
import { formatTokens } from "../compaction-message";
import { MarkdownBody } from "./markdown-body";
import { StepLabel, StepShell } from "./shell";
import type { StepPartOf, StepViewProps } from "./types";

/**
 * How the compaction was triggered, beside the row's action and in its body's
 * header.
 *
 * The wording matches `compaction.trigger.*`; the rest of a step row is written
 * in English here, so this row does not go through i18n on its own — half a row
 * in one language reads worse than the whole row in one.
 */
const TRIGGER_LABEL = {
  pressure: "automatic",
  manual: "manual",
  overflow: "overflow recovery",
} as const;

/**
 * A committed marker says what it cost; one still summarizing says nothing,
 * because the count is not known yet.
 */
export const compactionSummary = (
  part: StepPartOf<"compaction">
): string | undefined => (part.record ? "context compacted" : undefined);

/**
 * A compaction marker inside an assistant turn.
 *
 * It is one step of that turn, like a note or a call, so it reads as one row
 * and shows its summary behind the row. A manual compaction is a turn of its
 * own and uses `CompactionMessage` instead.
 */
export const CompactionStep = ({
  part,
  status,
  duration,
}: StepViewProps<"compaction">) => {
  const { record } = part;
  const trigger = record ? TRIGGER_LABEL[record.trigger] : undefined;
  const tokens =
    record &&
    `${formatTokens(record.tokensBefore)} → ${formatTokens(record.tokensAfter)} tokens`;

  return (
    <StepShell
      body={
        <Frame overflowBehavior="scroll" variant="default">
          <FrameHeader>
            <FrameTitle>
              Compact
              {trigger && (
                <span className="ml-2 font-normal text-muted-foreground text-xs">
                  {trigger}
                </span>
              )}
            </FrameTitle>
            {tokens && (
              <span className="text-muted-foreground text-xs">{tokens}</span>
            )}
          </FrameHeader>
          <FramePanel>
            <MarkdownBody text={record?.summary ?? ""} />
          </FramePanel>
        </Frame>
      }
      duration={duration}
      icon={<Minimize2Icon />}
      label={<StepLabel action="Compact" detail={trigger} />}
      status={status}
      summary={tokens || compactionSummary(part)}
    />
  );
};
