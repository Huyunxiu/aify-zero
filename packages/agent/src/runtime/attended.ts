import type { InboxItem } from "@workspace/agent-client";

/**
 * Tells whether a person is present for this Run.
 *
 * Only an Inbox Item from the user counts as attended. A Timer that fires and a job
 * notice both arrive when nobody watches, so their Runs use the stricter policy. A
 * Run that an approval answer starts does not use the Inbox, so it counts as attended.
 */
export function isAttendedRun(items: readonly InboxItem[]): boolean {
  return items.some((item) => item.kind === "user-message");
}
