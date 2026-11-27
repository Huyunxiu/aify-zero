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

export function composeSubagentNotice(settlement: SubagentSettlement): string {
  const head = `subagent ${settlement.name} (${settlement.subagentType}) settled: ${settlement.status}`;
  const report = settlement.report.trim();

  if (report.length === 0) {
    // A run that settled clean and said nothing is not an answer: its last turn
    // ended on a tool call. Say which of the two happened, so the parent can
    // tell an empty answer from a lost one.
    return settlement.status === "done"
      ? `${head}\n\nIt finished without a report: its last turn ended without one.`
      : `${head}\n\nIt reported nothing.`;
  }

  const body =
    report.length > REPORT_BUDGET
      ? `${report.slice(0, REPORT_BUDGET)}\n[report truncated]`
      : report;

  return `${head}\n\n${body}`;
}
