import type {
  AgentUserTurn,
  TextStreamToolApprovalResponseEvent,
} from "@workspace/agent-client";
import type { ModelEffort } from "@workspace/shared/constants";
import type { ModelRef } from "@workspace/shared/model";

import type { AgentSession } from "../agent-session";
import type { ApprovalPolicy } from "../approval-policy";
import type { InboxMode } from "../inbox/delivery";
import type { SteeringSignal } from "../inbox/steering";
import type { JobRegistry } from "../jobs/registry";
import type { AgentStore, SessionEndStatus } from "../storage";
import type { RecoveryOutcome, RecoveryStore } from "../storage/recovery";
import type { StreamEventRegistry } from "../stream-registry";
import type { AgentToolSet } from "../types";

/** 运行器需要的那一面：会话、turn、step、收件箱，加上恢复。 */
export type AgentRunnerStore = AgentStore & RecoveryStore;

/** 交付一条待办项之后怎么起跑。 */
export type RunStart =
  | {
      /** 答复之后还有没答完的调用：没有起跑，等下一个答复。 */
      status: "held";
      awaitingToolApprovals: number;
    }
  | {
      status: "running";
      activeStreamId: string;
      /** 这次运行落定时的状态；运行器靠它决定队列怎么走。 */
      settled: Promise<SessionEndStatus>;
    };

/** `start()` 的结果；恢复失败不会 reject，只进这里。 */
export type RunnerStartReport = {
  recovered: RecoveryOutcome[];
  woken: string[];
  failures: { sessionId?: string; error: string }[];
};

/** 运行器会停下来的两个终态。 */
export type PauseReason = "error" | "canceled";

/** 一次已经开始的运行。`RunStart` 的 running 分支是它的来源。 */
export type StartedRun = Extract<RunStart, { status: "running" }>;

export type RunnerState = {
  running: string[];
  waiting: string[];
  paused: { sessionId: string; reason: PauseReason }[];
};

export type CreateSessionInput = {
  sessionId: string;
  title?: string;
  projectId?: string;
  metadata?: unknown;
  /**
   * 会话的初始审批档位；只在插行时生效。
   *
   * 行已经存在时忽略：那多半是用户中途改过的，不能被一次重发覆盖。
   */
  approvalPolicy?: ApprovalPolicy;
};

export type EnqueueInput = {
  sessionId: string;
  turn: AgentUserTurn;
  model: ModelRef;
  effort?: ModelEffort;
  projectId?: string;
  /** 默认 `followup`：排到下一次运行，不插进正在跑的回合。 */
  mode?: InboxMode;
  /** 默认用 `turn.id`；同一条消息重试不会重复入队。 */
  dedupeKey?: string;
};

export type EnqueueNoticeInput = {
  sessionId: string;
  /** 通知正文；与用户消息同构，由任务结算处组好。 */
  text: string;
  /** 幂等键；同一个任务重复结算不会投第二条。 */
  dedupeKey: string;
};

export type ResumeInput = {
  sessionId: string;
  approvals: TextStreamToolApprovalResponseEvent[];
  model: ModelRef;
  effort?: ModelEffort;
};

/** 宿主组合 agent 时拿到的输入。 */
export type BuildAgentInput = {
  sessionId: string;
  session: AgentSession;
  model: ModelRef;
  effort?: ModelEffort;
  projectId?: string;
  /** 子会话工厂复用它，否则子会话会绕过运行器的锁。 */
  streams: StreamEventRegistry<AgentToolSet>;
  jobs?: JobRegistry;
  /** 这次运行的插话信号；等待任务的工具订阅它。 */
  steering?: SteeringSignal;
  /**
   * 这次运行生效的审批档位。
   *
   * 运行器已经按「有没有人在场」收紧过；宿主拿到的是生效值，不再自己判断。
   */
  approvalPolicy: ApprovalPolicy;
};

/** 运行器只依赖 `warn`；测试可以塞收集器。 */
export type AgentRunnerLogger = {
  warn(message: string, error?: unknown): void;
};
