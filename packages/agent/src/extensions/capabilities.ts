import type {
  AgentStreamEvent,
  AgentTurn,
  AgentTurnStatus,
} from "@workspace/agent-client";

import type { HooksManager } from "../hooks-manager";
import type { JobRegistry } from "../jobs/registry";
import type { CompactionStrategy } from "../kernel/compaction-strategy";
import type { ModelGateway } from "../kernel/model-gateway";
import type { AgentStore } from "../storage";
import type { SubagentDefinition } from "../subagent/definitions";
import type { AgentToolSet } from "../types";

/**
 * 工具构造时需要知道的环境。
 *
 * 它只描述“在哪里工作”：路径、会话身份和后台任务注册表。它不包含会话历史、
 * 存储和 provider。扩展拿到的是这份视图，拿不到完整的 `AgentContext`。
 */
export interface ToolEnvironment {
  readonly sessionId: string;
  readonly projectDirs: readonly string[];
  /** 主目录，即 `projectDirs[0]`。相对路径以它为基准。 */
  readonly primaryProjectDir: string;
  /** 当前会话的私有目录，存临时文件和 artifacts。 */
  readonly sessionDir: string;
  readonly projectId?: string;
  /** 后台任务注册表；省略时后台执行和任务控制工具都不可用。 */
  readonly jobs?: JobRegistry;
}

/** 只读的会话 transcript。工具读它来找到自己的调用和结果。 */
export interface TranscriptReader {
  turns(): readonly AgentTurn<AgentToolSet>[];
}

export interface SubagentRequest {
  definition: SubagentDefinition;
  prompt: string;
  description: string;
  /** 父会话里发起这次调用的工具调用 id。 */
  toolCallId: string;
}

export interface SubagentRunResult {
  report: string;
  status: AgentTurnStatus["status"];
  sessionId: string;
}

/**
 * 一次已经开始的子会话。
 *
 * `sessionId` 在流注册完成后才可用；`wait` 等到子流结束，返回它的最终报告。
 */
export interface SubagentRun {
  readonly sessionId: string;
  wait(): Promise<SubagentRunResult>;
}

/** 由父 agent 提供的子会话入口。 */
export interface SubagentFactory {
  start(request: SubagentRequest): Promise<SubagentRun>;
}

/**
 * 往当前流写协议事件。
 *
 * 没有正在运行的流时写入被丢弃：后台任务（标题、摘要）可能在流关闭后才
 * 结束，那时事件已经没有读者。
 */
export interface EventWriter {
  write(event: AgentStreamEvent<AgentToolSet>): Promise<void>;
}

/**
 * 一个带类型的 capability 名。
 *
 * 运行时只读 `id`；`__type` 只参与类型推断，让 `use` 和 `provide` 对得上。
 */
export interface CapabilityToken<T> {
  readonly id: string;
  readonly __type?: T;
}

export function capability<T>(id: string): CapabilityToken<T> {
  return { id };
}

export const Capabilities = {
  transcript: capability<TranscriptReader>("transcript"),
  subagents: capability<SubagentFactory>("subagents"),
  /** 模型调用的端口，供扩展发起自己的模型调用。 */
  model: capability<ModelGateway>("model"),
  /** 会话存储，供扩展读写自己负责的行。 */
  store: capability<AgentStore>("store"),
  /** 当前流的写入口。 */
  events: capability<EventWriter>("events"),
  /** hook 总线；扩展既能监听，也能发出自己的事件。 */
  hooks: capability<HooksManager>("hooks"),
  /** 当前回合的取消信号；空闲时返回 undefined。 */
  abortSignal: capability<() => AbortSignal | undefined>("abortSignal"),
  /** 上下文压缩策略；没有提供者时压缩不可用。 */
  compaction: capability<CompactionStrategy>("compaction"),
} as const;
