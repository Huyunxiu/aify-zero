import type { ModelMessage, ToolResultPart } from "ai";

import { estimateMessageTokens } from "./estimate";

/** 用来替代超大工具结果中间被删掉的部分。 */
export const PRUNE_MARKER = "\n\n[... tool result middle pruned ...]\n\n";

export interface PruneOptions {
  /** 距尾部这么多 token 以内的消息永远不会被剪枝。 */
  keepRecentTokens: number;
  /** 只有长度超过这么多字符的结果才会成为候选。 */
  thresholdChars: number;
  headChars: number;
  tailChars: number;
}

type ToolResultOutput = ToolResultPart["output"];

function capText(text: string, options: PruneOptions): string | undefined {
  if (text.length <= options.thresholdChars) {
    return undefined;
  }
  // 幂等：已经带标记的结果保持原样，第二次投影不会继续把它削小。
  if (text.includes(PRUNE_MARKER)) {
    return undefined;
  }

  const tail = options.tailChars > 0 ? text.slice(-options.tailChars) : "";
  return `${text.slice(0, options.headChars)}${PRUNE_MARKER}${tail}`;
}

function renderContentOutput(
  value: Extract<ToolResultOutput, { type: "content" }>["value"]
): string {
  return value
    .map((part) => {
      if ("text" in part && typeof part.text === "string") {
        return part.text;
      }
      const filename = "filename" in part ? part.filename : undefined;
      const mediaType = "mediaType" in part ? part.mediaType : "file";
      return `[Attached file ${filename ?? "attachment"} (${mediaType})]`;
    })
    .join("\n");
}

function pruneOutput(
  output: ToolResultOutput,
  options: PruneOptions
): ToolResultOutput | undefined {
  switch (output.type) {
    case "text":
    case "error-text": {
      const capped = capText(output.value, options);
      return capped === undefined ? undefined : { ...output, value: capped };
    }
    case "json":
    case "error-json": {
      const serialized = JSON.stringify(output.value) ?? "";
      const capped = capText(serialized, options);
      if (capped === undefined) {
        return undefined;
      }
      return {
        type: output.type === "json" ? "text" : "error-text",
        value: capped,
      };
    }
    case "content": {
      const rendered = renderContentOutput(output.value);
      const capped = capText(rendered, options);
      return capped === undefined ? undefined : { type: "text", value: capped };
    }
    case "execution-denied": {
      return undefined;
    }
    default: {
      return undefined;
    }
  }
}

/**
 * 确定性的、不依赖模型的第一级压缩：把受保护尾部之外、体积过大的工具结果
 * 中间部分裁掉。
 *
 * 消息结构和 tool-call/tool-result 的配对完全不动——只缩小结果负载——因此可以
 * 在每次请求前执行，不需要摘要调用。它是幂等的，所以下一次投影能在刷新后重建
 * 出同样的历史。
 */
export function pruneOlderToolResults(
  messages: readonly ModelMessage[],
  options: PruneOptions
): ModelMessage[] {
  if (messages.length === 0) {
    return messages as ModelMessage[];
  }

  let tailTokens = 0;
  let protectedFrom = messages.length;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message) {
      continue;
    }
    const tokens = estimateMessageTokens(message);
    if (tailTokens + tokens > options.keepRecentTokens) {
      break;
    }
    tailTokens += tokens;
    protectedFrom = index;
  }
  // 即使预算为零，也始终保护最新一条消息。
  protectedFrom = Math.min(protectedFrom, messages.length - 1);

  let changed = false;
  const pruned = messages.map((message, index) => {
    if (index >= protectedFrom || message.role !== "tool") {
      return message;
    }

    let messageChanged = false;
    const content = message.content.map((part) => {
      if (part.type !== "tool-result") {
        return part;
      }
      const output = pruneOutput(part.output, options);
      if (output === undefined) {
        return part;
      }
      messageChanged = true;
      return { ...part, output };
    });

    if (!messageChanged) {
      return message;
    }
    changed = true;
    return { ...message, content };
  });

  return changed ? pruned : (messages as ModelMessage[]);
}
