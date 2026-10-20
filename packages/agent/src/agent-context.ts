import type {
  AgentStreamEvent,
  CompactionConfig,
} from "@workspace/agent-client";

import { AgentState } from "./agent-state";
import type { AgentStateOptions } from "./agent-state";
import type { SystemPromptSection } from "./extensions/types";
import { SkillManager } from "./skill";
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
  /**
   * 技能按名字查询用（`load-skill` 工具）：插件加载完由宿主写入，省略时
   * 是一份空表。系统提示里的技能列表不从这里来。
   */
  skills?: SkillManager;
  /**
   * 启动时注册的系统提示片段。子 agent 从这里继承，保证主会话和子会话
   * 看到同一套说明。
   */
  systemPromptSections?: readonly SystemPromptSection[];
  compactionConfig: CompactionConfig;
  controller?: AgentStreamEventController;
};
export class AgentContext extends AgentState {
  workdir: string;
  skills: SkillManager;
  systemPromptSections: readonly SystemPromptSection[];
  /** The Agent that owns this context sets it; its `abort()` triggers it. */
  abortSignal?: AbortSignal;
  compactionConfig: CompactionConfig;
  controller?: AgentStreamEventController;

  constructor(options: AgentContextOptions) {
    super(options);
    this.workdir = options.workdir;
    this.skills = options.skills ?? new SkillManager({ dirs: [] });
    this.systemPromptSections = options.systemPromptSections ?? [];
    this.compactionConfig = options.compactionConfig;
    this.controller = options.controller;
  }
  [x: string]: unknown;
}
