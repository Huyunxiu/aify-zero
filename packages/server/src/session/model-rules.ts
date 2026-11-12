import type { AgentToolSet } from "@workspace/agent";
import type { AgentTurn, AgentUserTurn } from "@workspace/agent-client";
import type { ModelEffort } from "@workspace/shared/constants";

import type { ConfiguredModel } from "../routers/settings/settings.schema";

/**
 * 这一轮带了、但模型不接受的输入种类。
 *
 * 前端已经按 modalities 隐藏了上传入口，这里再拦一次：客户端可以绕过前端。
 */
export function unsupportedInput(
  configured: ConfiguredModel,
  turn: AgentUserTurn
): string | undefined {
  const accepted = new Set<string>(
    configured.model.modalities?.input ?? ["text"]
  );
  for (const step of turn.content) {
    for (const part of step.content) {
      if (part.type !== "file") {
        continue;
      }
      const [kind] = part.mediaType.split("/");
      if (kind && !accepted.has(kind)) {
        return kind;
      }
    }
  }
  return undefined;
}

/**
 * 整段历史里第一个模型不接受的内容种类。
 *
 * 只查最后一轮不够：附件可能来自更早的回合，模型换过之后它们仍然会被重放。
 */
export function unsupportedInputIn(
  configured: ConfiguredModel,
  turns: readonly AgentTurn<AgentToolSet>[]
): string | undefined {
  for (const turn of turns) {
    if (turn.type !== "user") {
      continue;
    }
    const kind = unsupportedInput(configured, turn);
    if (kind !== undefined) {
      return kind;
    }
  }
}

/**
 * 模型接受的推理档位。
 *
 * 档位是偏好，不是内容：模型不支持推理时忽略它，而不是让整轮失败——用户的
 * 客户端可能还留着上一次的选择。`reasoning` 缺省表示未知，按支持处理。
 */
export function acceptedEffort(
  configured: ConfiguredModel,
  effort: ModelEffort | undefined
): ModelEffort | undefined {
  return configured.model.reasoning === false ? undefined : effort;
}
