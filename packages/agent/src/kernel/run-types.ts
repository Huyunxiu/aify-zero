import type { AgentTurn, AgentUserTurn } from "@workspace/agent-client";
import type { ModelRef } from "@workspace/shared/model";

import type { SessionEndStatus } from "../storage";
import type { AgentToolSet } from "../types";

/**
 * What a stream is asked to run.
 *
 * A turn is the ordinary case: a user turn is in `turns` and the model drives it
 * to an ending. A compaction is the same stream machinery applied to the manual
 * `/compact` path: there is no model turn to run, the agent folds the history
 * itself and writes the marker, and the stream reports it like any other turn.
 * The union is what keeps both behind one entry point — a caller sends the
 * signal, the agent decides what that means.
 */
export type AgentStreamSignal =
  | { readonly type: "turn" }
  | { readonly type: "compaction"; readonly trigger: "manual" };

/** 一条待领取的待办项：收件箱行的 id，以及它要变成的 user 回合。 */
export type InboxClaim = {
  inboxId: string;
  turn: AgentUserTurn;
};

export type AgentStreamOptions = {
  model: ModelRef;
  turns: AgentTurn<AgentToolSet>[];
  /**
   * 这次运行的 id；就是会话行上的 `activeStreamId`。
   *
   * step 行把它记进 `step.stream_id`。读取时用它区分“当前运行刚写下的
   * step”和上一次运行留下的 step，避免页面中途加载后又被流重放一遍。
   */
  streamId: string;
  /** What this stream runs; see {@link AgentStreamSignal}. */
  signal: AgentStreamSignal;
  /**
   * How the run ended, so the caller can settle the session it belongs to. The
   * outcome is only known here, once the run has finished.
   *
   * `turn` is the assistant turn this stream drove, when it produced one. The
   * host needs it to tell a reply that said something from one that only ran
   * tools; a compaction never has one.
   */
  onFinish: (
    status: SessionEndStatus,
    turn?: AgentTurn<AgentToolSet>
  ) => Promise<void>;
  /**
   * 这次运行要领的待办项，以及它们各自的 user 回合。
   *
   * 保存 turn 时原子删除这些收件箱行；一条都删不到说明整批已被另一个调用者
   * 领走，本次启动会失败，而不是写出重复的 user 回合。删到一部分说明其余被
   * 取消了：只有领到的那几条进入模型历史，`turns` 只是它们之前的历史。
   */
  claims?: readonly InboxClaim[];
  /**
   * 这次运行真正写下的 user 回合 id，顺序即记录里的顺序。
   *
   * 领到之后、`stream()` 兑现之前调用一次；没有领待办项时不调用。会话事件
   * 通道用它填 `run.start`，所以值必须来自领取结果，而不是调用方的猜测。
   */
  onClaimed?: (turnIds: readonly string[]) => void;
};

/** 手工压缩被要求压缩一段没有可压缩内容的历史。 */
export class NothingToCompactError extends Error {
  override readonly name = "NothingToCompactError";
}
