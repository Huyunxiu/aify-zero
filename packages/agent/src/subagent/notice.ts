/**
 * The subagent completion notice: one message that tells a parent session what a
 * subagent settled as, and what it said.
 *
 * It carries facts only. Naming a tool here would put a second copy of a rule in
 * a message that cannot keep it true, and the one instruction a delegation needs
 * — do not poll, end the turn — already lives in the subagent catalogue.
 */

import {
  SUBAGENT_NOTICE,
  SUBAGENT_NOTICE_INBOX_KIND,
} from "@workspace/agent-client";

import type { SubagentSettlement } from "../extensions/capabilities";
import type { NoticeRequest } from "../inbox/notice-writer";

/** The longest report a notice carries before it says it was cut. */
const REPORT_BUDGET = 4000;

/**
 * The status a settlement is reported with.
 *
 * A run that ended clean and said nothing is not an answer: its last turn ended
 * on a tool call, so the parent was handed nothing to act on. It settles as an
 * error, because nothing else in the notice would say so.
 */
export function settledStatus(status: string, report: string): string {
  return status === "done" && report.trim().length === 0 ? "error" : status;
}

export function composeSubagentNotice(settlement: SubagentSettlement): string {
  const head = `subagent ${settlement.name} (${settlement.subagentType}) settled: ${settlement.status}`;
  const report = settlement.report.trim();
  const dropped = droppedLine(settlement.dropped);

  if (report.length === 0) {
    return `${head}\n\nIt finished without a report.${dropped}`;
  }

  const body =
    report.length > REPORT_BUDGET
      ? `${report.slice(0, REPORT_BUDGET)}\n[report truncated]`
      : report;

  return `${head}\n\n${body}${dropped}`;
}

/**
 * How many items are written.
 *
 * One renderer, because the stop tool and the settlement notice report the same
 * number: two pluralizers would let the parent read "2 waiting messages" and
 * "2 waiting items" about one fact.
 *
 * @param count - How many items.
 * @returns The count with its noun, for example `2 waiting items`.
 */
export function waitingItems(count: number): string {
  return `${String(count)} waiting ${count === 1 ? "item" : "items"}`;
}

/**
 * The line that says the items never arrived.
 *
 * It belongs in the notice rather than in silence: the settlement already tells
 * the parent the run is over, and this is the one fact that run still owes — what
 * it accepted and never read.
 */
function droppedLine(dropped: number): string {
  if (dropped === 0) {
    return "";
  }

  return `\n\nIt never read ${waitingItems(dropped)}; ${
    dropped === 1 ? "it is" : "they are"
  } gone.`;
}

/**
 * The one notice a settlement leaves behind.
 *
 * Composition and addressing live together: the text says what happened, the
 * dedupe key names the child, and the form says it is a subagent's notice. A
 * producer that assembled these three apart could file a settlement as a job's.
 */
export function subagentNoticeRequest(
  settlement: SubagentSettlement
): NoticeRequest {
  return {
    sessionId: settlement.parentSessionId,
    text: composeSubagentNotice(settlement),
    // The run is part of the key: a child can settle more than once, and the
    // second settlement is not a duplicate of the first.
    dedupeKey: `${SUBAGENT_NOTICE_INBOX_KIND}:${settlement.sessionId}:${
      settlement.runKey ?? "recovered"
    }`,
    form: SUBAGENT_NOTICE,
  };
}
