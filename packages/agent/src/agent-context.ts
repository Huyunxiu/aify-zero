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
  /**
   * agent 可以读写代码的项目目录，至少一项。
   *
   * 第一项是主目录（primary）：工具的相对路径和资源加载都以它为基准。其余
   * 目录只是额外可访问的根，模型访问它们时必须用绝对路径。
   */
  projectDirs: readonly string[];
  /**
   * agent 自己的会话目录，存临时文件和 artifacts。和项目目录的区别是
   * 生命周期：它属于当前 session，会话结束即可清理，不会被用户提交。
   */
  sessionDir: string;
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
  projectDirs: readonly string[];
  /** 主目录，即 `projectDirs[0]`。构造时保证存在。 */
  readonly primaryProjectDir: string;
  sessionDir: string;
  skills: SkillManager;
  systemPromptSections: readonly SystemPromptSection[];
  /** The Agent that owns this context sets it; its `abort()` triggers it. */
  abortSignal?: AbortSignal;
  compactionConfig: CompactionConfig;
  controller?: AgentStreamEventController;

  constructor(options: AgentContextOptions) {
    super(options);
    // 主目录是数组的约定，不是独立字段：这里拆出来让类型收窄，避免每个
    // 消费点都对 `projectDirs[0]` 做一次 undefined 判断。
    const [primaryProjectDir, ...otherProjectDirs] = options.projectDirs;
    if (!primaryProjectDir) {
      throw new Error("AgentContext requires at least one project directory");
    }
    this.projectDirs = [primaryProjectDir, ...otherProjectDirs];
    this.primaryProjectDir = primaryProjectDir;
    this.sessionDir = options.sessionDir;
    this.skills = options.skills ?? new SkillManager({ dirs: [] });
    this.systemPromptSections = options.systemPromptSections ?? [];
    this.compactionConfig = options.compactionConfig;
    this.controller = options.controller;
  }
  [x: string]: unknown;
}
