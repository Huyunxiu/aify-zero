import {
  AgentTurnBuilder,
  findTurnWithoutToolResult,
} from "@workspace/agent-client";
import type { AgentTurn, CompactionRecord } from "@workspace/agent-client";
import type { TurnModel } from "@workspace/db";
import type { LanguageModelUsage, ModelMessage } from "ai";
import { addLanguageModelUsage } from "ai/internal";

import type { AgentStepResult } from "./agents";
import { projectHistory } from "./compaction/project";
import type { ProjectedHistory, UsageAnchor } from "./compaction/types";
import type { AgentToolSet } from "./types";
import { generateTurnId } from "./utils/id-util";

export type AgentSessionOptions = {
  turns: AgentTurn<AgentToolSet>[];
  builder?: AgentTurnBuilder<AgentToolSet>;
};

export class AgentSession {
  turns: AgentTurn<AgentToolSet>[];
  modelMessages: ModelMessage[];
  builder?: AgentTurnBuilder<AgentToolSet>;
  usage?: LanguageModelUsage;
  totalUsage?: LanguageModelUsage;
  /** 当前 turn 开始时模型侧的历史视图。 */
  projected: ProjectedHistory;
  /** 模型最近一次真正看到的 prompt，用于压力测量。 */
  lastUsage?: UsageAnchor;

  constructor({ turns }: AgentSessionOptions) {
    this.turns = turns;
    this.modelMessages = [];
    this.projected = { messages: [], turnAnchors: [], stepAnchors: [] };
  }

  static toAgentTurns(turns: TurnModel[]): AgentTurn<AgentToolSet>[] {
    return turns.map((e) => e.content as AgentTurn<AgentToolSet>);
  }

  /**
   * 读入一条 branch，得到模型侧历史，但不开启 turn。
   *
   * 手工压缩没有模型回合，只需要投影和锚点；和 `startTurn` 共用同一段
   * 投影逻辑，避免两条路径对同一条 branch 得出不同的理解。
   */
  async loadTurns({ turns }: AgentSessionOptions): Promise<void> {
    this.turns = turns;
    this.projected = await projectHistory(this.turns);
    this.modelMessages = this.projected.messages;
    this.lastUsage = this.projected.usageAnchor;
  }

  async startTurn({ turns }: AgentSessionOptions): Promise<string> {
    await this.loadTurns({ turns });
    this.builder = new AgentTurnBuilder<AgentToolSet>({
      turns: this.turns,
    });
    const turn = findTurnWithoutToolResult(this.turns);
    return turn ? turn.id : generateTurnId();
  }

  /**
   * 记住上一步真正发送的 prompt，让下一次压力检查测量真实上下文，
   * 而不是重新估算整段历史。
   */
  noteStepUsage(usage: LanguageModelUsage, messageIndex: number): void {
    const { inputTokens } = usage;
    if (typeof inputTokens === "number" && inputTokens > 0) {
      this.lastUsage = { messageIndex, inputTokens };
    }
  }

  /**
   * 采用一次压缩产生的历史。
   *
   * checkpoint 成为第一条消息，usage 锚点被丢弃：旧锚点描述的是已经不存在的
   * prompt。
   */
  applyCompaction(input: {
    checkpoint: CompactionRecord;
    messages: ModelMessage[];
  }): void {
    this.modelMessages = input.messages;
    this.lastUsage = undefined;
    this.projected = {
      messages: input.messages,
      turnAnchors: [],
      stepAnchors: [],
      checkpoint: input.checkpoint,
    };
  }

  finishStep(stepResult: AgentStepResult) {
    this.modelMessages = stepResult.messages;

    if (this.usage === undefined) {
      this.usage = stepResult.usage;
    } else {
      this.usage = stepResult.usage;
    }

    if (this.totalUsage === undefined) {
      this.totalUsage = this.usage;
    } else if (this.usage) {
      this.totalUsage = addLanguageModelUsage(this.totalUsage, this.usage);
    }
  }

  finishTurn({ turn }: { turn: AgentTurn<AgentToolSet> | undefined }) {
    if (!turn) {
      return;
    }

    this.turns.push(turn);
  }
}
