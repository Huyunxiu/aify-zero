import type { Agent } from "../agents";
import type { Subagents } from "../extensions/capabilities";
import type { NoticeWriter } from "../inbox/notice-writer";
import type { AgentStore } from "../storage";
import type { StreamEventRegistry } from "../stream-registry";
import type { AgentToolSet } from "../types";
import { SubagentSupervisor } from "./supervisor";

export { SubagentLimitReachedError, SubagentNotFoundError } from "./supervisor";

export interface SubagentFactoryOptions {
  agent: Agent;
  store: AgentStore;
  /** The runner's registry; a child session must register in it like any other. */
  registry: StreamEventRegistry<AgentToolSet>;
  /** Notice writer used when a child settles. */
  notices?: NoticeWriter;
  /** How many subagents one session may run at once. */
  limit?: number;
  /** The wall clock a single child run may take. Zero disables it. */
  timeoutMs?: number;
  /** The clock, so a test can move time without waiting for it. */
  now?: () => number;
}

/**
 * Turn one parent agent into the `subagents` capability.
 *
 * Wraps a single-use `SubagentSupervisor` for callers outside `AgentRunner`.
 */
export function createSubagentFactory({
  agent,
  store,
  registry,
  notices,
  limit,
  timeoutMs,
  now,
}: SubagentFactoryOptions): Subagents {
  return new SubagentSupervisor({
    store,
    registry,
    ...(notices === undefined ? {} : { notices }),
    ...(limit === undefined ? {} : { limit }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(now === undefined ? {} : { now }),
  }).forParent(agent);
}
