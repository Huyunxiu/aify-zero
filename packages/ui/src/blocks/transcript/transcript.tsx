/**
 * The record itself: the scrolling list of turns, and the outline beside it.
 *
 * This is the one place that draws a turn as a message. A session being read and
 * written and a read-only subagent show the same record. They differ only in who
 * answers an approval and who types the next thing, and those are the page's
 * business, not the record's: the caller leaves the optional callbacks out.
 */
import type {
  AgentToolSet,
  AgentTurn,
  BotSummary,
} from "@workspace/agent-client";
import { getErrorMessage } from "@workspace/shared/errors";
import { MessageSquareIcon } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../../components/empty";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
  useMessageScroller,
  useMessageScrollerVisibility,
} from "../../components/message-scroller";
import ProximitySidebar from "../../components/ui/proximity-sidebar";
import type { SessionOutlineSection } from "../../lib/session-outline";
import { cn } from "../../lib/utils";
import { AssistantMessage } from "../assistant-message";
import type { ToolApprovalAnswer } from "../chain-of-turn";
import { CompactionMessage } from "../compaction-message";
import { Message, MessageContent, MessageResponse } from "../message";
import type { QuestionnairePlacement } from "../questionnaire";
import { UserMessage } from "../user-message";

/** The outline beside the record: the anchors, and the sections between them. */
export type TranscriptOutline = {
  /**
   * The ids of every user turn, in the order they happened.
   *
   * A skipped system turn is an anchor too, so the active marker must use the
   * anchor to decide which section the reader is after, not the section alone.
   */
  readonly anchors: string[];
  readonly sections: SessionOutlineSection[];
};

/** What the record says before its first turn lands. */
export type TranscriptEmpty = {
  readonly description: string;
  readonly title: string;
};

export type TranscriptProps = {
  readonly turns: AgentTurn<AgentToolSet>[];
  /** The Bot that owns the session; its face stands beside every answer. */
  readonly bot?: BotSummary | null;
  /** The failure that ended the last run, if any. */
  readonly error?: unknown;
  /** What to say when no turn has landed yet. */
  readonly empty: TranscriptEmpty;
  /**
   * Answers a call a turn was held on.
   *
   * Left out when nobody here can answer: a read-only record belongs to the
   * `task` call that made it, and only that call can answer for it.
   */
  readonly onRespondToolApproval?: (
    approvalId: string,
    approved: boolean,
    answer?: ToolApprovalAnswer
  ) => void;
  /** Forks the session at one of its answers. Left out for a read-only one. */
  readonly onFork?: (messageId: string) => void;
  /**
   * Where a held questionnaire draws its form.
   *
   * `"inline"` — the default — keeps the form in the record, beside the call
   * that asked. `"composer"` leaves it to the page that owns the prompt input.
   */
  readonly questionnairePlacement?: QuestionnairePlacement;
  /** The outline beside the record. Left out for a read-only one. */
  readonly outline?: TranscriptOutline;
};

type SessionOutlineProps = {
  readonly anchors: string[];
  readonly sections: SessionOutlineSection[];
};

/**
 * The outline: it marks the section the reader is in, and a click goes there.
 *
 * One section is one question, and only user turns are anchors, so the active
 * section is the last question at or above the reading line. When the anchor
 * sits on a skipped system turn, the nearest section before it wins. The jump
 * uses `scrollToMessage`, the same action as "go to a message".
 */
function SessionOutline({ anchors, sections }: SessionOutlineProps) {
  const { t } = useTranslation();
  const { currentAnchorId } = useMessageScrollerVisibility();
  const { scrollToMessage } = useMessageScroller();

  const activeId = React.useMemo(() => {
    const first = sections[0]?.id;

    if (!currentAnchorId) {
      return first;
    }

    const anchorIndex = anchors.indexOf(currentAnchorId);
    if (anchorIndex === -1) {
      return first;
    }

    return (
      sections.findLast((section) => section.anchorIndex <= anchorIndex)?.id ??
      first
    );
  }, [anchors, currentAnchorId, sections]);

  return (
    <ProximitySidebar
      activeId={activeId}
      className="py-6"
      label={t("sessions.outline")}
      onSelect={(id) => {
        scrollToMessage(id, { align: "start", behavior: "smooth" });
      }}
      sections={sections}
      side="left"
    />
  );
}

/**
 * Draws a record from its turns.
 *
 * @param props.outline - The outline beside it; leave it out and none is drawn,
 * and no room is kept for one.
 * @param props.empty - What to write when no turn has landed yet.
 */
export function Transcript({
  bot,
  empty,
  error,
  onFork,
  onRespondToolApproval,
  outline,
  questionnairePlacement,
  turns,
}: TranscriptProps) {
  // The outline and the scrolling box sit side by side. A wheel event over the
  // outline must go back to the record when the outline cannot scroll further.
  const contentRef = React.useRef<HTMLDivElement>(null);
  const hasOutline = outline !== undefined;

  return (
    <div className="relative flex-1" ref={contentRef}>
      <MessageScrollerProvider
        autoScroll
        defaultScrollPosition="start"
        scrollPreviousItemPeek={64}
      >
        <div className="absolute inset-0 touch-pan-y overflow-y-auto bg-transparent">
          <div
            className={cn(
              "relative size-full mx-auto flex min-h-full min-w-0 w-full flex-col",
              hasOutline && "@min-[1100px]:ps-[104px]"
            )}
          >
            <MessageScroller>
              <MessageScrollerViewport>
                <MessageScrollerContent className="px-0 py-4 max-w-[calc(56rem+16px)] mx-auto">
                  {turns.length === 0 ? (
                    <Empty className="h-full">
                      <EmptyHeader>
                        <EmptyMedia variant="icon">
                          <MessageSquareIcon />
                        </EmptyMedia>
                        <EmptyTitle>{empty.title}</EmptyTitle>
                        <EmptyDescription>{empty.description}</EmptyDescription>
                      </EmptyHeader>
                    </Empty>
                  ) : (
                    <>
                      {turns.map((turn) => (
                        <MessageScrollerItem
                          key={turn.id}
                          messageId={turn.id}
                          scrollAnchor={turn.type === "user"}
                        >
                          <Turn
                            bot={bot}
                            onFork={onFork}
                            onRespondToolApproval={onRespondToolApproval}
                            questionnairePlacement={questionnairePlacement}
                            turn={turn}
                          />
                        </MessageScrollerItem>
                      ))}
                      {error !== undefined && error !== null && (
                        <MessageScrollerItem scrollAnchor={false}>
                          <Message from="assistant">
                            <MessageContent>
                              <MessageResponse className="text-destructive">
                                {getErrorMessage(error)}
                              </MessageResponse>
                            </MessageContent>
                          </Message>
                        </MessageScrollerItem>
                      )}
                    </>
                  )}
                </MessageScrollerContent>
              </MessageScrollerViewport>
              <MessageScrollerButton />
            </MessageScroller>
          </div>
        </div>
        {outline && (
          <div
            className="absolute inset-y-0 start-0 hidden w-26 @min-[1100px]:block"
            onWheel={(event) => {
              // Let a long outline scroll itself first, and hand the rest back
              // to the record.
              const list = event.currentTarget.querySelector<HTMLElement>(
                "[data-proximity-list]"
              );
              if (
                event.target instanceof Node &&
                list?.contains(event.target) &&
                list.scrollHeight > list.clientHeight
              ) {
                return;
              }

              contentRef.current
                ?.querySelector<HTMLElement>(
                  '[data-slot="message-scroller-viewport"]'
                )
                ?.scrollBy({ top: event.deltaY });
            }}
          >
            <SessionOutline
              anchors={outline.anchors}
              sections={outline.sections}
            />
          </div>
        )}
      </MessageScrollerProvider>
    </div>
  );
}

type TurnProps = {
  readonly turn: AgentTurn<AgentToolSet>;
  readonly bot?: BotSummary | null;
  readonly onRespondToolApproval?: TranscriptProps["onRespondToolApproval"];
  readonly onFork?: (messageId: string) => void;
  readonly questionnairePlacement?: QuestionnairePlacement;
};

/** One turn: a question the reader asked, or what the model wrote. */
function Turn({
  bot,
  onFork,
  onRespondToolApproval,
  questionnairePlacement,
  turn,
}: TurnProps) {
  if (turn.type === "user") {
    return <UserMessage turn={turn} />;
  }

  if (turn.type === "compaction") {
    const [step] = turn.content;
    const record = step?.content.find(
      (part) => part.type === "compaction"
    )?.record;
    return <CompactionMessage record={record} />;
  }

  if (turn.type === "assistant") {
    return (
      <AssistantMessage
        bot={bot}
        onFork={onFork}
        onRespondToolApproval={onRespondToolApproval}
        questionnairePlacement={questionnairePlacement}
        turn={turn}
      />
    );
  }

  return null;
}
