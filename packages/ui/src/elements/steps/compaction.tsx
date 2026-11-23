import { Minimize2Icon } from "lucide-react";

import { formatTokens } from "../compaction-message";
import { RenderedSection } from "../tool-panels";
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
  const detail = [trigger, tokens]
    .filter((value) => value !== undefined)
    .join(" · ");

  return (
    <StepShell
      body={
        <RenderedSection
          label={
            <>
              Compact
              {detail && (
                <span className="ml-2 font-sans font-normal text-muted-foreground text-xs normal-case tracking-normal">
                  {detail}
                </span>
              )}
            </>
          }
        >
          <MarkdownBody text={record?.summary ?? ""} />
        </RenderedSection>
      }
      duration={duration}
      icon={<Minimize2Icon />}
      label={<StepLabel action="Compact" detail={trigger} />}
      status={status}
      summary={tokens || compactionSummary(part)}
    />
  );
};
