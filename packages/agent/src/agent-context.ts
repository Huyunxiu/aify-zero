import type { AgentStreamEvent } from "@workspace/agent-client";

import { AgentState } from "./agent-state";
import type { AgentStateOptions } from "./agent-state";
import type { ResolvedCompactionPolicy, SummarizeFn } from "./compaction/types";
import type { InstructionsSection } from "./extensions/types";
import type { JobRegistry } from "./jobs/registry";
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
   * 当前会话 id。后台任务的归属、以及取消和执行器回写都以它为界。
   */
  sessionId: string;
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
   * 当前会话所属的项目 id。宿主从请求里拿到后传进来，写会话行时用它归类；
   * 没有项目归属的调用方可以省略。
   */
  projectId?: string;
  /**
   * 技能按名字查询用（`load-skill` 工具）：插件加载完由宿主写入，省略时
   * 是一份空表。系统提示里的技能列表不从这里来。
   */
  skills?: SkillManager;
  /**
   * 启动时注册的系统提示片段。子 agent 从这里继承，保证主会话和子会话
   * 看到同一套说明。
   */
  instructionsSections?: readonly InstructionsSection[];
  /**
   * 宿主根据模型窗口和用户设置解析出的上下文压缩策略。测试和不需要压缩的
   * 嵌入调用方可以不传。
   */
  compaction?: ResolvedCompactionPolicy;
  /**
   * 覆盖默认摘要器；测试在这里注入假实现。
   */
  summarize?: SummarizeFn;
  /**
   * 每个已配置模型的上下文窗口，按 model id 索引。子 agent 跑在自己的模型上，
   * 从这里解析自己的窗口。
   */
  modelContextWindows?: Readonly<Record<string, number>>;
  /**
   * 后台任务注册表。任务要比启动它的那次请求活得久，所以它由宿主创建并
   * 传给每个会话上下文；省略时 `bash` 等工具不提供后台执行，也不注册任务
   * 控制工具。
   */
  jobs?: JobRegistry;
  controller?: AgentStreamEventController;
};
export class AgentContext extends AgentState {
  projectDirs: readonly string[];
  /** 主目录，即 `projectDirs[0]`。构造时保证存在。 */
  readonly primaryProjectDir: string;
  sessionId: string;
  sessionDir: string;
  projectId?: string;
  skills: SkillManager;
  instructionsSections: readonly InstructionsSection[];
  compaction?: ResolvedCompactionPolicy;
  summarize?: SummarizeFn;
  modelContextWindows?: Readonly<Record<string, number>>;
  /** The Agent that owns this context sets it; its `abort()` triggers it. */
  abortSignal?: AbortSignal;
  jobs?: JobRegistry;
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
    this.sessionId = options.sessionId;
    this.sessionDir = options.sessionDir;
    this.projectId = options.projectId;
    this.skills = options.skills ?? new SkillManager({ dirs: [] });
    this.instructionsSections = options.instructionsSections ?? [];
    this.compaction = options.compaction;
    this.summarize = options.summarize;
    this.modelContextWindows = options.modelContextWindows;
    this.jobs = options.jobs;
    this.controller = options.controller;
  }
  [x: string]: unknown;
}
