import { logger } from "@workspace/shared/logger";

import type { Agent } from "../agents";
import { Capabilities } from "../extensions/capabilities";
import type {
  SubagentFactory,
  SubagentRequest,
  SubagentRun,
} from "../extensions/capabilities";
import type { AgentStore } from "../storage";
import { STREAM_REGISTRY } from "../stream-registry";
import { createSubagent, readSubagentResult } from "./create";
import type { SubagentParent } from "./create";

export interface SubagentFactoryOptions {
  agent: Agent;
  store: AgentStore;
}

/**
 * 把父 agent 变成 `SubagentFactory` capability。
 *
 * 子会话的创建、流注册和结果读取都留在这里；`task` 工具只依赖
 * {@link SubagentFactory} 和 {@link TranscriptReader}，不再 import `Agent`。
 */
export function createSubagentFactory({
  agent,
  store,
}: SubagentFactoryOptions): SubagentFactory {
  return {
    start: (request) => startSubagent(agent, store, request),
  };
}

async function startSubagent(
  agent: Agent,
  store: AgentStore,
  request: SubagentRequest
): Promise<SubagentRun> {
  // 父的审批函数在 start 时读：组合根在构造之后才注册，构造工厂时可能还没注册完。
  const parent: SubagentParent = {
    context: agent.context,
    tools: agent.tools,
    credentials: {
      apiKey: agent.apiKey,
      apiUrl: agent.apiUrl,
      providerId: agent.providerId,
    },
    sessionId: agent.sessionId,
    toolCallId: request.toolCallId,
    toolApprovalPattern: agent.toolApprovalPattern,
    compaction: agent.extensions.capability(Capabilities.compaction),
  };

  const { agent: subagent, turns } = await createSubagent(parent, {
    definition: request.definition,
    prompt: request.prompt,
    description: request.description,
    store,
  });

  // Registered under the subagent's own session id rather than the parent's,
  // so a reader holding the call can follow the transcript it produced and
  // stopping or reading the parent's session does not walk into it.
  const activeStreamId = subagent.sessionId;

  // 子会话的行和父会话一样要维护状态。这一笔写在 stream 之前：子流可能
  // 在 setActiveStream 落库之前就跑完，那时 onFinish 里的 clearActiveStream
  // 会认不出自己的 streamId 而直接返回，行就永远卡在 running。
  await store.setActiveStream(subagent.sessionId, activeStreamId);

  try {
    const stream = await subagent.stream({
      turns,
      modelId: subagent.context.modelId,
      streamId: activeStreamId,
      signal: { type: "turn" },
      onFinish: async (status) => {
        await STREAM_REGISTRY.unregisterStream(activeStreamId);
        await store.clearActiveStream(
          subagent.sessionId,
          activeStreamId,
          status
        );
      },
    });

    const entry = STREAM_REGISTRY.registerStream(
      activeStreamId,
      subagent,
      stream
    );
    const { sessionId } = subagent;

    return {
      sessionId,
      wait: async () => {
        // The call does not return until the subagent has ended, because what
        // the parent does with the answer is read it.
        await entry.whenFinished();
        const { report, status } = readSubagentResult(subagent.session.turns);

        return { report, status, sessionId };
      },
    };
  } catch (error) {
    await subagent.dispose();

    try {
      await store.clearActiveStream(
        subagent.sessionId,
        activeStreamId,
        "error"
      );
    } catch (clearError) {
      logger.warn("[subagent] failed to clear the active stream", clearError);
    }

    throw error;
  }
}
