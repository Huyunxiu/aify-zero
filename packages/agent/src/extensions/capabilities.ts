import type { AgentStreamEvent, AgentTurn } from "@workspace/agent-client";
import type { Sandbox } from "@workspace/sandbox";

import type { HooksManager } from "../hooks-manager";
import type { NoticeWriter } from "../inbox/notice-writer";
import type { SteeringSignal } from "../inbox/steering";
import type { JobRegistry } from "../jobs/registry";
import type { CompactionStrategy } from "../kernel/compaction-strategy";
import type { ModelGateway } from "../kernel/model-gateway";
import type { AgentStore } from "../storage";
import type { SubagentDefinition } from "../subagent/definitions";
import type { SessionTimers } from "../timers/types";
import type { AgentToolSet } from "../types";

/**
 * 工具构造时需要知道的环境。
 *
 * 它只描述“在哪里工作”：路径、会话身份、后台任务注册表和沙箱。它不包含会话
 * 历史、存储和 provider。扩展拿到的是这份视图，拿不到完整的 `AgentContext`。
 */
export interface ToolEnvironment {
  readonly sessionId: string;
  readonly projectDirs: readonly string[];
  /** 主目录，即 `projectDirs[0]`。相对路径以它为基准。 */
  readonly primaryProjectDir: string;
  /** 当前会话的私有目录，存临时文件和 artifacts。 */
  readonly sessionDir: string;
  readonly projectId?: string;
  readonly botId?: string;
  /** Persistent workspace directory of the owning Bot. */
  readonly botWorkspaceDir?: string;
  /** 后台任务注册表；省略时后台执行和任务控制工具都不可用。 */
  readonly jobs?: JobRegistry;
  /**
   * 绑到当前会话上的定时器视图；省略时定时器工具不注册。
   *
   * 子会话没有自己的视图，但它继承父会话的工具集，工具闭包里绑的是父的那份：
   * 子会话排的定时器属于父会话，到点在父会话触发（和后台任务同一条规矩）。
   */
  readonly timers?: SessionTimers;
  /** 用户插话信号；省略时等待只能靠中止或超时结束。 */
  readonly steering?: SteeringSignal;
  /**
   * The media kinds the current model route accepts, as the settings schema spells
   * them. A tool that produces content of another kind must refuse and say so.
   */
  readonly inputKinds?: readonly string[];
  /** 工具读写文件和运行命令的环境。 */
  readonly sandbox: Sandbox;
}

/** 只读的会话 transcript。工具读它来找到自己的调用和结果。 */
export interface TranscriptReader {
  turns(): readonly AgentTurn<AgentToolSet>[];
}

/** One subagent, as `list-agents` reports it. */
export interface SubagentSummary {
  readonly name: string;
  readonly sessionId: string;
  /**
   * What kind of thing the name reaches.
   *
   * It is a constant today, and it is here so the shape does not change when a
   * session can also reach a bot or a team by name: a reader picks a row by its
   * kind, not by which tool listed it.
   */
  readonly kind: "subagent";
  readonly subagentType: string;
  /** The session status word: running, idle, done, error, canceled, or wait_review. */
  readonly status: string;
  /** How long the current run has been going. Absent when it is not running. */
  readonly runningMs?: number;
}

export interface SubagentListResult {
  readonly running: number;
  readonly limit: number;
  readonly subagents: readonly SubagentSummary[];
}

export interface SubagentCreateRequest {
  readonly definition: SubagentDefinition;
  readonly prompt: string;
  readonly description: string;
  /** The parent tool call that made it; the same call re-run finds the same child. */
  readonly toolCallId: string;
}

export interface SubagentCreated {
  /** The name the parent session reaches it by; null only for a row older than names. */
  readonly name: string | null;
  readonly sessionId: string;
}

/**
 * How a handoff reached its subagent: it started a run now, or queued behind one.
 *
 * "Handoff" is the inbound side — a sentence put into a model loop. "Delivery"
 * is the outbound side, and it belongs to the completion notice below.
 */
export type SubagentHandoff = "started" | "queued";

/** A settled subagent, in the terms its parent is told about it. */
export interface SubagentSettlement {
  readonly parentSessionId: string;
  readonly sessionId: string;
  readonly name: string;
  readonly subagentType: string;
  readonly status: string;
  readonly report: string;
}

/**
 * The delegation surface one session offers to its own tools.
 *
 * Every method is scoped to the session that provides it: a name reaches a child
 * of that session and no other.
 */
export interface Subagents {
  create(request: SubagentCreateRequest): Promise<SubagentCreated>;
  list(): Promise<SubagentListResult>;
  handoff(request: { name: string; text: string }): Promise<SubagentHandoff>;
  /** Whether a live run was stopped. A subagent that already finished was not. */
  stop(request: { name: string }): Promise<boolean>;
}

/**
 * 一个装配时没就绪的服务器，以及模型搜不到它工具的原因。
 *
 * 「这台服务器上真的没有那个工具」和「这台服务器没连上」是两件事，搜索
 * 结果必须分开说，否则模型会换个词继续搜一个根本搜不到的服务器。
 */
export type CatalogUnavailable = {
  server: string;
  /** 给模型看的原因短语，例如 `needs authorization`。 */
  reason: string;
};

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
  subagents: capability<Subagents>("subagents"),
  /**
   * The one way anything settles in the background and tells a session about it.
   *
   * An extension that finishes work later reaches its session through this,
   * instead of being handed a port from outside.
   */
  notices: capability<NoticeWriter>("notices"),
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
  /**
   * 工具目录里搜不到的服务器。
   *
   * 只有 MCP 扩展会提供它；没有 MCP 的会话不存在这个能力，所以读的人是
   * 用 `optional` 问，而不是 `use`。
   */
  catalogUnavailable:
    capability<() => readonly CatalogUnavailable[]>("catalogUnavailable"),
} as const;
