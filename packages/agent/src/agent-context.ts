import type {
  AgentStreamEvent,
  CompactionConfig,
} from "@workspace/agent-client";

import { AgentState } from "./agent-state";
import type { AgentStateOptions } from "./agent-state";
import type { SkillManager } from "./skill";
import type { AgentToolSet } from "./types";

export interface AgentStreamEventController {
  /**
   * Appends a data stream part to the stream.
   */
  write(data: AgentStreamEvent<AgentToolSet>): Promise<void>;
  close(): void;
  /**
   * Error handler that is used by the data stream controller.
   * This is intended for forwarding when merging streams
   * to prevent duplicated error masking.
   */
  error: (error: unknown) => void;
}

export type AgentContextOptions = AgentStateOptions & {
  workdir: string;
  skills: SkillManager;
  compactionConfig: CompactionConfig;
  controller?: AgentStreamEventController;
};
export class AgentContext extends AgentState {
  workdir: string;
  skills: SkillManager;
  /** The Agent that owns this context sets it; its `abort()` triggers it. */
  abortSignal?: AbortSignal;
  compactionConfig: CompactionConfig;
  controller?: AgentStreamEventController;

  constructor(options: AgentContextOptions) {
    super(options);
    this.workdir = options.workdir;
    this.skills = options.skills;
    this.compactionConfig = options.compactionConfig;
    this.controller = options.controller;
  }
  [x: string]: unknown;
}
