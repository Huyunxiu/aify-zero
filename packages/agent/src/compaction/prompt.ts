import type { ModelMessage } from "ai";

import { estimateTokens } from "./estimate";

/**
 * 压缩后模型侧历史开头的合成 user 消息。它说明这段内容是什么，并明确要求模型
 * 不要回应它——checkpoint 是背景，不是新的指令。
 */
const CHECKPOINT_PREAMBLE =
  "This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.";

export function frameCheckpoint(summary: string): string {
  return `${CHECKPOINT_PREAMBLE}\n\n<compacted-summary>\n${summary.trim()}\n</compacted-summary>`;
}

const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;

const COMPACTION_INSTRUCTION = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Constraints, preferences, or requirements mentioned by the user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

## Files and Code
- [Exact paths, functions, commands, error strings, identifiers and measured values that matter]

Rules:
- Keep every section, in order. Use terse bullets, not prose paragraphs. Write "(none)" for an empty section.
- Preserve exact file paths, function names, commands, error messages, identifiers and numeric values.
- Capture user feedback and corrections faithfully; preserve the user's most recent request verbatim when it is still the task.
- Write in the same language as the conversation.
- Do NOT mention this summarization request or that the context was compacted.
- Output only the checkpoint text: do not call any tool or take any other action.`;

const DEFAULT_PAYLOAD_LIMIT = 2000;
const DEGRADED_PAYLOAD_LIMIT = 280;

type ContentPart = Exclude<ModelMessage["content"], string>[number];

function capText(text: string, limit?: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (limit === undefined || normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit).trimEnd()}…`;
}

function renderFileStub(
  filename: string | undefined,
  mediaType: string
): string {
  return `[Attached file ${filename ?? "attachment"} (${mediaType})]`;
}

function renderToolOutput(output: unknown, limit: number): string {
  if (output === null || typeof output !== "object") {
    return capText(
      typeof output === "string" ? output : (JSON.stringify(output) ?? ""),
      limit
    );
  }

  const candidate = output as { type?: unknown; value?: unknown };
  if (candidate.type === "text" || candidate.type === "error-text") {
    return capText(
      typeof candidate.value === "string"
        ? candidate.value
        : (JSON.stringify(candidate.value) ?? ""),
      limit
    );
  }
  if (candidate.type === "content" && Array.isArray(candidate.value)) {
    return capText(
      candidate.value
        .map((part: unknown) => {
          if (part === null || typeof part !== "object") {
            return "";
          }
          const contentPart = part as {
            type?: unknown;
            text?: unknown;
            filename?: unknown;
            mediaType?: unknown;
          };
          if (contentPart.type === "text") {
            return typeof contentPart.text === "string" ? contentPart.text : "";
          }
          return renderFileStub(
            typeof contentPart.filename === "string"
              ? contentPart.filename
              : undefined,
            typeof contentPart.mediaType === "string"
              ? contentPart.mediaType
              : "file"
          );
        })
        .join("\n"),
      limit
    );
  }
  if (candidate.type === "execution-denied") {
    return "[Tool execution denied]";
  }

  return capText(JSON.stringify(output) ?? "", limit);
}

function renderPart(part: ContentPart, payloadLimit: number): string {
  switch (part.type) {
    case "text": {
      return part.text.trim();
    }
    case "reasoning": {
      // 对大多数 provider 来说，重放的 reasoning 不属于活跃上下文；把它算进来
      // 还可能让摘要请求比它要摘要的上下文还大。
      return "";
    }
    case "file": {
      return renderFileStub(part.filename, part.mediaType);
    }
    case "tool-call": {
      const input = capText(JSON.stringify(part.input) ?? "", payloadLimit);
      return input
        ? `Called ${part.toolName} with ${input}`
        : `Called ${part.toolName}`;
    }
    case "tool-result": {
      const output = renderToolOutput(part.output, payloadLimit);
      return output
        ? `Tool ${part.toolName} returned ${output}`
        : `Tool ${part.toolName} returned`;
    }
    case "tool-approval-request": {
      return `[Tool approval requested for ${part.toolCallId}]`;
    }
    case "tool-approval-response": {
      return `[Tool approval ${part.approved ? "approved" : "denied"}]`;
    }
    case "custom":
    case "image":
    case "reasoning-file": {
      return "";
    }
    default: {
      return "";
    }
  }
}

function renderMessage(
  message: ModelMessage,
  payloadLimit: number
): string | undefined {
  if (message.role === "system") {
    return undefined;
  }

  if (typeof message.content === "string") {
    return `[${message.role}]\n${capText(message.content)}`;
  }

  const rendered = message.content
    .map((part) => renderPart(part, payloadLimit))
    .filter((entry) => entry.length > 0)
    .join("\n")
    .trim();
  if (rendered.length === 0) {
    return undefined;
  }

  const label =
    message.role === "tool"
      ? "Tool result"
      : message.role === "assistant"
        ? "Assistant"
        : "User";
  return `[${label}]\n${rendered}`;
}

function renderTranscript(
  messages: readonly ModelMessage[],
  payloadLimit: number
): string {
  return messages
    .map((message) => renderMessage(message, payloadLimit))
    .filter((entry): entry is string => entry !== undefined)
    .join("\n\n");
}

function formatPrompt(previousSummary: string, transcript: string): string {
  return `<previous-checkpoint>
${previousSummary}
</previous-checkpoint>

<conversation>
${transcript || "(empty)"}
</conversation>

${COMPACTION_INSTRUCTION}`;
}

export interface SummarizationPrompt {
  system: string;
  prompt: string;
}

/**
 * 构造摘要请求。
 *
 * 会话被序列化成文本，而不是按消息重放：收到真实前缀的模型倾向于顺着往下写，
 * 而且在这个应用面对的 OpenAI-compatible 端点上，provider 的前缀缓存并不可靠。
 * 工具负载会截断、reasoning 丢弃；渲染后的 prompt 放不进摘要模型自己的窗口时，
 * 从最旧的消息开始丢弃，而不是让调用失败。
 */
export function createSummarizationPrompt(input: {
  messages: readonly ModelMessage[];
  previousSummary?: string;
  maxPromptTokens?: number;
}): SummarizationPrompt {
  const previousSummary = input.previousSummary?.trim() || "(none)";
  const budget = input.maxPromptTokens;

  let { messages } = input;
  let prompt = formatPrompt(
    previousSummary,
    renderTranscript(messages, DEFAULT_PAYLOAD_LIMIT)
  );

  if (budget !== undefined && estimateTokens(prompt) > budget) {
    prompt = formatPrompt(
      previousSummary,
      renderTranscript(messages, DEGRADED_PAYLOAD_LIMIT)
    );
  }

  // 摘要调用本身也必须放得下。每次丢掉最旧的一批消息；最新的上下文才是下一个
  // 模型最需要的。
  for (;;) {
    if (
      budget === undefined ||
      estimateTokens(prompt) <= budget ||
      messages.length <= 1
    ) {
      break;
    }
    const drop = Math.max(1, Math.ceil(messages.length * 0.1));
    messages = messages.slice(drop);
    prompt = formatPrompt(
      previousSummary,
      renderTranscript(messages, DEGRADED_PAYLOAD_LIMIT)
    );
  }

  return { system: SUMMARIZATION_SYSTEM_PROMPT, prompt };
}
