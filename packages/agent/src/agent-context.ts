import type {
  AgentStreamEvent,
  CompactionConfig,
} from "@workspace/agent-client";

import { AgentState } from "./agent-state";
import type { AgentStateOptions } from "./agent-state";
import type { ContextFile } from "./context-files";
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
  /**
   * 启动时加载的 AGENTS.md / CLAUDE.md。子 agent 从这里继承，保证主会话和
   * 子会话看到同一套项目说明。
   */
  contextFiles?: ContextFile[];
  compactionConfig: CompactionConfig;
  controller?: AgentStreamEventController;
};
export class AgentContext extends AgentState {
  workdir: string;
  skills: SkillManager;
  contextFiles: ContextFile[];
  /** The Agent that owns this context sets it; its `abort()` triggers it. */
  abortSignal?: AbortSignal;
  compactionConfig: CompactionConfig;
  controller?: AgentStreamEventController;

  constructor(options: AgentContextOptions) {
    super(options);
    this.workdir = options.workdir;
    this.skills = options.skills;
    this.contextFiles = options.contextFiles ?? [];
    this.compactionConfig = options.compactionConfig;
    this.controller = options.controller;
  }
  [x: string]: unknown;
}
