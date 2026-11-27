/**
 * The subagent completion notice: one message that tells a parent session what a
 * subagent settled as, and what it said.
 *
 * It carries facts only. Naming a tool here would put a second copy of a rule in
 * a message that cannot keep it true, and the one instruction a delegation needs
 * — do not poll, end the turn — already lives in the subagent catalogue.
 */

import type { SubagentSettlement } from "../extensions/capabilities";

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

  if (report.length === 0) {
    return `${head}\n\nIt finished without a report.`;
  }

  const body =
    report.length > REPORT_BUDGET
      ? `${report.slice(0, REPORT_BUDGET)}\n[report truncated]`
      : report;

  return `${head}\n\n${body}`;
}
