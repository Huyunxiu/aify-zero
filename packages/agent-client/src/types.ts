import type {
  DeepPartial,
  FinishReason,
  InferUITool,
  LanguageModelUsage,
  ProviderMetadata,
  ProviderReference,
  StaticToolOutputDenied,
  StepResultPerformance,
  Tool,
  ToolSet,
  TypedToolCall,
  TypedToolError,
  TypedToolResult,
  UITool,
} from "ai";

/**
 * A JSON value can be a string, number, boolean, object, array, or null.
 * JSON values can be serialized and deserialized by the JSON.stringify and JSON.parse methods.
 */
export type JSONValue =
  | null
  | string
  | number
  | boolean
  | Readonly<JSONObject>
  | readonly JSONValue[];
export type JSONObject = {
  [key: string]: JSONValue | undefined;
};

export type AgentRuntimeContext = Record<string, unknown>;

/** 这次压缩为什么发生。 */
export type CompactionTrigger = "pressure" | "manual" | "overflow";

/**
 * 一次压缩：替换掉历史前缀的摘要，以及这次替换的代价。
 *
 * 它挂在 {@link AgentCompactionPart} 的 `record` 上；part 在 turn 时间线上的位置
 * 就是边界，因此不需要指向保留历史的指针。摘要是模型的原始输出——面向模型的
 * checkpoint framing 在投影时再加。
 */
export interface CompactionRecord {
  /** 记录的数据结构版本，用于兼容未来格式变更。 */
  version: 1;
  /** 这次压缩的标识；与 part id 一致。 */
  id: string;
  /** 压缩触发方式：上下文压力、手动请求，或请求溢出。 */
  trigger: CompactionTrigger;
  /** 结构化摘要，不含 checkpoint framing。 */
  summary: string;
  /** 压缩前投影历史的 token 数；优先使用模型 usage，否则使用估算值。 */
  tokensBefore: number;
  /** 压缩后 checkpoint 与保留历史的估算 token 数，不含系统提示和工具 schema。 */
  tokensAfter: number;
  /** 被摘要替换的消息内容的估算 token 数。 */
  shadowedTokens: number;
  /** 被摘要替换内容覆盖的 turn 数。 */
  shadowedTurns: number;
  /** 被摘要替换内容覆盖的 step 数。 */
  shadowedSteps: number;
  /** 生成摘要的模型。 */
  model: string;
  /**
   * 手工压缩保留段的起点。
   *
   * checkpoint 替代这条 turn 之前的全部历史，这条 turn 及其后的 turn 原文保留。
   * 切点写在记录里而不是靠 compaction turn 在 branch 中的位置表达，因此手工
   * 压缩的 turn 可以线性追加到 branch 末尾。缺省表示全量压缩（marker 之前全部
   * 被 checkpoint 替代）。
   */
  retainedFromTurnId?: string;
  /** 摘要调用自身的 usage；绝不是会话的 usage。 */
  usage?: LanguageModelUsage;
  /** 压缩记录创建时间，以 Unix 毫秒时间戳表示。 */
  createdAt: number;
}

type TextStreamEventBase = {
  turnId: string;
  stepId: string;
  createdAt: number;
};
type TextStreamTextStartEvent = TextStreamEventBase & {
  type: "text.start";
  id: string;
  providerMetadata?: ProviderMetadata;
};
type TextStreamTextDeltaEvent = TextStreamEventBase & {
  type: "text.delta";
  id: string;
  providerMetadata?: ProviderMetadata;
  text: string;
};
type TextStreamTextEndEvent = TextStreamEventBase & {
  type: "text.end";
  id: string;
  providerMetadata?: ProviderMetadata;
};
type TextStreamCustomContentEvent = TextStreamEventBase & {
  type: "custom";
  /**
   * The kind of custom content, in the format `{provider}.{provider-type}`.
   */
  kind: `${string}.${string}`;
  providerMetadata?: ProviderMetadata;
};
type TextStreamReasoningStartEvent = TextStreamEventBase & {
  type: "reasoning.start";
  id: string;
  providerMetadata?: ProviderMetadata;
};
type TextStreamReasoningEndEvent = TextStreamEventBase & {
  type: "reasoning.end";
  id: string;
  providerMetadata?: ProviderMetadata;
};
type TextStreamReasoningDeltaEvent = TextStreamEventBase & {
  type: "reasoning.delta";
  providerMetadata?: ProviderMetadata;
  id: string;
  text: string;
};
type TextStreamToolInputStartEvent = TextStreamEventBase & {
  type: "tool.input-start";
  id: string;
  toolName: string;
  providerMetadata?: ProviderMetadata;
  toolMetadata?: JSONObject;
  providerExecuted?: boolean;
  dynamic?: boolean;
  title?: string;
};
type TextStreamToolInputEndEvent = TextStreamEventBase & {
  type: "tool.input-end";
  id: string;
  providerMetadata?: ProviderMetadata;
};
type TextStreamToolInputDeltaEvent = TextStreamEventBase & {
  type: "tool.input-delta";
  id: string;
  delta: string;
  providerMetadata?: ProviderMetadata;
};
export type TextStreamToolApprovalRequestEvent = TextStreamEventBase & {
  type: "tool.approval-request";
  id: string;
  approvalId: string;
  approvalDescriptor?: unknown;
  inputSchemaInput?: unknown;
  reason?: string;
  isAutomatic?: boolean;
  signature?: string;
};
export type TextStreamToolApprovalResponseEvent = TextStreamEventBase & {
  type: "tool.approval-response";
  id: string;
  approvalId: string;
  approved: boolean;
  reason?: string;
  /**
   * Opaque, JSON-serializable payload for the application.
   *
   * It rides along with the answer and is kept on the approval, so a feature
   * can attach what it needs to a decision without a protocol change. The agent
   * never reads it, and it is not sent to the model.
   */
  data?: JSONObject;
  providerExecuted?: boolean;
  providerMetadata?: ProviderMetadata;
};
/**
 * Renames the `type` discriminant of a part.
 *
 * Renaming is what the `extends unknown` distribution is for: the tool parts
 * are unions with one member per tool, and an `Omit` applied to such a union as
 * a whole collapses it to the members' shared keys, turning every `toolName`
 * and `input` into a union of all tools. Intersecting with `{ type: "tool.call" }`
 * is no better — the parts already declare `type`, so it narrows to `never`.
 */
type RenameEventType<T, TYPE extends string> = T extends unknown
  ? Omit<T, "type"> & { type: TYPE }
  : never;

type TextStreamToolCallEvent<TOOLS extends ToolSet> = TextStreamEventBase &
  RenameEventType<TypedToolCall<TOOLS>, "tool.call">;
type TextStreamToolResultEvent<TOOLS extends ToolSet> = TextStreamEventBase &
  RenameEventType<TypedToolResult<TOOLS>, "tool.result">;
type TextStreamToolErrorEvent<TOOLS extends ToolSet> = TextStreamEventBase &
  RenameEventType<TypedToolError<TOOLS>, "tool.error">;
type TextStreamToolOutputDeniedEvent<TOOLS extends ToolSet> =
  TextStreamEventBase &
    RenameEventType<StaticToolOutputDenied<TOOLS>, "tool.output-denied">;
export type TextStreamStartStepEvent = {
  id: string;
  turnId: string;
  type: "step.start";
  createdAt: number;
  stepType: AgentStep<any>["type"];
  /**
   * The model the step is about to be produced with. No other part of the
   * stream reports it, and `AgentAssistantStep.model` is needed as soon as the
   * step object is — while it is still streaming.
   */
  model: string;
};
export type TextStreamFinishStepEvent = AgentStepStatus & {
  id: string;
  turnId: string;
  type: "step.finish";
  createdAt: number;
  usage: LanguageModelUsage;
  finishReason: FinishReason;
  rawFinishReason: string | undefined;
  providerMetadata: ProviderMetadata | undefined;
  metadata?: StepMetadata;
};
export type TextStreamStepMetadataEvent = {
  id: string;
  turnId: string;
  type: "step.metadata";
  createdAt: number;
  metadata: StepMetadata;
};
/**
 * 一条引导消息已插入当前 assistant turn。
 *
 * `step` 是完整的 steering step：客户端按 id upsert 到 turn 的步骤列表，
 * 同时按同一个 id 从待发送队列里移除它。它不开启新的 turn，所以没有
 * `step.start` / `step.finish` 配对。
 */
export type TextStreamSteerEvent = {
  type: "turn.steer";
  turnId: string;
  step: AgentSteeringStep;
  createdAt: number;
};
export type TextStreamStartTurnEvent = {
  id: string;
  createdAt: number;
  type: "turn.start";
  turnType: AgentTurn<any>["type"];
};
export type TextStreamFinishTurnEvent = AgentTurnStatus & {
  id: string;
  type: "turn.finish";
  createdAt: number;
  usage?: LanguageModelUsage;
};

export type TextStreamTitleStartEvent = TextStreamEventBase & {
  id: string;
  type: "session.title.start";
  createdAt: number;
};
export type TextStreamTitleEndEvent = TextStreamEventBase & {
  id: string;
  type: "session.title.end";
  title: string;
  createdAt: number;
};
/**
 * 一次压缩即将开始。
 *
 * 事件带着 placement 决定的 turn/step：压缩 part 从这一刻起就以 `"streaming"`
 * 存在，摘要完成后由 `compaction.end` 补上记录。失败的尝试由
 * `compaction.error` 撤回，历史保持原样。
 */
type TextStreamCompactionStartEvent = TextStreamEventBase & {
  type: "compaction.start";
  id: string;
  trigger: CompactionTrigger;
};
/** 压缩尝试失败；历史未改变，尚未提交的 part 会被撤回。 */
type TextStreamCompactionErrorEvent = {
  type: "compaction.error";
  id: string;
  error: unknown;
  createdAt: number;
};
/**
 * 摘要已就绪，标记 step 即将提交。assembler 会把记录写到 `compaction.start`
 * 建立、仍在 streaming 的 part 上。
 */
type TextStreamCompactionEndEvent = TextStreamEventBase & {
  type: "compaction.end";
  id: string;
  record: CompactionRecord;
};
type TextStreamAbortEvent = TextStreamEventBase & {
  type: "abort";
  reason?: string;
};
type TextStreamErrorEvent = TextStreamEventBase & {
  type: "error";
  error: unknown;
};
export type AgentStreamEvent<TOOLS extends ToolSet> =
  | TextStreamTextStartEvent
  | TextStreamTextEndEvent
  | TextStreamTextDeltaEvent
  | TextStreamCustomContentEvent
  | TextStreamReasoningStartEvent
  | TextStreamReasoningEndEvent
  | TextStreamReasoningDeltaEvent
  | TextStreamToolInputStartEvent
  | TextStreamToolInputEndEvent
  | TextStreamToolApprovalRequestEvent
  | TextStreamToolApprovalResponseEvent
  | TextStreamToolInputDeltaEvent
  | TextStreamToolCallEvent<TOOLS>
  | TextStreamToolResultEvent<TOOLS>
  | TextStreamToolErrorEvent<TOOLS>
  | TextStreamToolOutputDeniedEvent<TOOLS>
  | TextStreamStartStepEvent
  | TextStreamFinishStepEvent
  | TextStreamStepMetadataEvent
  | TextStreamSteerEvent
  | TextStreamStartTurnEvent
  | TextStreamFinishTurnEvent
  | TextStreamTitleStartEvent
  | TextStreamTitleEndEvent
  | TextStreamAbortEvent
  | TextStreamErrorEvent
  | TextStreamCompactionStartEvent
  | TextStreamCompactionErrorEvent
  | TextStreamCompactionEndEvent;

export type AgentSessionTitlePart = {
  id: string;
  type: "session.title";
  /**
   * The text content.
   */
  title?: string;
  /**
   * The state of the text part.
   */
  state?: "streaming" | "done";
};
export function isAgentSessionTitlePart<TOOLS extends ToolSet>(
  part: AgentPart<TOOLS>
): part is AgentSessionTitlePart {
  return part.type === "session.title";
}

/**
 * 压缩标记 step 的负载：一条记录，整体提交。
 *
 * 自动压缩的 part 从 `compaction.start` 起以 `"streaming"` 存在，摘要完成时
 * 由 `compaction.end` 补上 `record` 并置为 `"done"`；失败的尝试不会留下 part。
 * 手工压缩直接写入 `"done"`，因为它没有流式过程。
 *
 * 做成 part 而不是 step 上的字段，是为了让 turn 的 content 和其它 step 一样
 * 保持为 part 列表，卡片渲染器也能用同样的方式处理内联（自动）和 turn 级
 * （手工）标记。
 */
export type AgentCompactionPart = {
  type: "compaction";
  id: string;
  state: "streaming" | "done";
  /**
   * Epoch (ms) the compaction started.
   */
  createdAt: number;
  /**
   * Epoch (ms). Absent while the compaction is still running, and on a marker
   * that never streamed (manual compaction): those have no span to show.
   */
  completedAt?: number;
  record?: CompactionRecord;
};
export function isAgentCompactionPart<TOOLS extends ToolSet>(
  part: AgentPart<TOOLS>
): part is AgentCompactionPart {
  return part.type === "compaction";
}

/**
 * A text part of a message.
 */
export type AgentTextPart = {
  type: "text";
  /**
   * The text content.
   */
  text: string;
  /**
   * The state of the text part.
   */
  state?: "streaming" | "done";
  /**
   * Epoch (ms) the text started streaming.
   */
  createdAt: number;
  /**
   * Epoch (ms). Absent while the text is still streaming.
   */
  completedAt?: number;
  /**
   * The provider metadata.
   */
  providerMetadata?: ProviderMetadata;
};
export function isAgentTextPart<TOOLS extends ToolSet>(
  part: AgentPart<TOOLS>
): part is AgentTextPart {
  return part.type === "text";
}

/**
 * A text part of a message.
 */
export type AgentCustomContentPart = {
  type: "custom";
  /**
   * The kind of custom content, in the format `{provider}.{provider-type}`.
   */
  kind: `${string}.${string}`;
  /**
   * The provider metadata.
   */
  providerMetadata?: ProviderMetadata;
};
export function isAgentCustomContentPart<TOOLS extends ToolSet>(
  part: AgentPart<TOOLS>
): part is AgentCustomContentPart {
  return part.type === "custom";
}

/**
 * A reasoning part of a message.
 */
export type AgentReasoningPart = {
  type: "reasoning";
  /**
   * The reasoning text.
   */
  text: string;
  /**
   * The state of the reasoning part.
   */
  state?: "streaming" | "done";
  /**
   * Epoch (ms) the reasoning started streaming.
   */
  createdAt: number;
  /**
   * Epoch (ms). Absent while the reasoning is still streaming.
   */
  completedAt?: number;
  /**
   * The provider metadata.
   */
  providerMetadata?: ProviderMetadata;
};
export function isAgentReasoningPart<TOOLS extends ToolSet>(
  part: AgentPart<TOOLS>
): part is AgentReasoningPart {
  return part.type === "reasoning";
}
export type AgentFilePart = {
  type: "file";
  /**
   * Either a full IANA media type (`type/subtype`, e.g. `image/png`) or just
   * the top-level IANA segment (e.g. `image`, `audio`, `video`, `text`).
   *
   * `*`-subtype wildcards (e.g. `image/*`) are normalized as equivalent to the
   * top-level segment alone (e.g. `image`). Providers can use the helpers in
   * `@ai-sdk/provider-utils` (`isFullMediaType`, `getTopLevelMediaType`,
   * `detectMediaType`) to resolve the field according to their API
   * requirements.
   *
   * @see https://www.iana.org/assignments/media-types/media-types.xhtml
   */
  mediaType: string;
  /**
   * Optional filename of the file.
   */
  filename?: string;
  /**
   * The URL of the file.
   * It can either be a URL to a hosted file or a [Data URL](https://developer.mozilla.org/en-US/docs/Web/HTTP/Basics_of_HTTP/Data_URLs).
   */
  url: string;
  /**
   * Provider reference for files uploaded via `uploadFile`.
   * Maps provider names to provider-specific file identifiers.
   * When present, takes precedence over `url` in model messages.
   */
  providerReference?: ProviderReference;
  /**
   * The provider metadata.
   */
  providerMetadata?: ProviderMetadata;
};
export function isAgentFilePart<TOOLS extends ToolSet>(
  part: AgentPart<TOOLS>
): part is AgentFilePart {
  return part.type === "file";
}
type asUITool<TOOL extends UITool | Tool> = TOOL extends Tool
  ? InferUITool<TOOL>
  : TOOL;
/**
 * Create a union of the given object's values, and optionally specify which keys to get the values from.
 *
 * Please upvote [this issue](https://github.com/microsoft/TypeScript/issues/31438) if you want to have this type as a built-in in TypeScript.
 *
 * @example
 * ```
 * // data.json
 * {
 * 	'foo': 1,
 * 	'bar': 2,
 * 	'biz': 3
 * }
 *
 * // main.ts
 * import type {ValueOf} from 'type-fest';
 * import data = require('./data.json');
 *
 * export function getData(name: string): ValueOf<typeof data> {
 * 	return data[name];
 * }
 *
 * export function onlyBar(name: string): ValueOf<typeof data, 'bar'> {
 * 	return data[name];
 * }
 *
 * // file.ts
 * import {getData, onlyBar} from './main';
 *
 * getData('foo');
 * //=> 1
 *
 * onlyBar('foo');
 * //=> TypeError ...
 *
 * onlyBar('bar');
 * //=> 2
 * ```
 * @see https://github.com/sindresorhus/type-fest/blob/main/source/value-of.d.ts
 */
type ValueOf<
  ObjectType,
  ValueType extends keyof ObjectType = keyof ObjectType,
> = ObjectType[ValueType];
/**
 * A UI tool invocation contains all the information needed to render a tool invocation in the UI.
 *
 * Parameterized by the resolved input and output types, so that a known tool
 * (`AgentToolInvocation`) and an opaque dynamic one (`AgentDynamicToolPart`)
 * share a single definition of the invocation state machine. `DeepPartial` of
 * an `unknown` input is `unknown`, which is exactly what the dynamic case
 * wants, so nothing is lost by going through the parameterized form.
 */
type AgentToolInvocationBase<INPUT, OUTPUT> = {
  /**
   * ID of the tool call.
   */
  toolCallId: string;
  title?: string;
  toolMetadata?: JSONObject;
  /**
   * Whether the tool call was executed by the provider.
   */
  providerExecuted?: boolean;
  callProviderMetadata?: ProviderMetadata;
  resultProviderMetadata?: ProviderMetadata;
  preliminary?: boolean;
} & (
  | {
      state: "input-streaming";
      input?: DeepPartial<INPUT> | undefined;
      output?: never;
      errorText?: never;
      callProviderMetadata?: ProviderMetadata;
      approval?: never;
    }
  | {
      state: "input-available";
      input: INPUT;
      output?: never;
      errorText?: never;
      callProviderMetadata?: ProviderMetadata;
      approval?: never;
    }
  | {
      state: "approval-requested";
      input: INPUT;
      output?: never;
      errorText?: never;
      callProviderMetadata?: ProviderMetadata;
      approval: {
        id: string;
        approved?: never;
        descriptor?: unknown;
        requestReason?: string;
        reason?: never;
        data?: never;
        isAutomatic?: boolean;
        signature?: string;
        inputSchemaInput?: unknown;

        createdAt: number;
        approvedAt?: number;
      };
    }
  | {
      state: "approval-responded";
      input: INPUT;
      output?: never;
      errorText?: never;
      callProviderMetadata?: ProviderMetadata;
      approval: {
        id: string;
        approved: boolean;
        descriptor?: unknown;
        requestReason?: string;
        reason?: string;
        data?: JSONObject;
        isAutomatic?: boolean;
        signature?: string;
        inputSchemaInput?: unknown;

        createdAt: number;
        approvedAt: number;
      };
    }
  | {
      state: "output-available";
      input: INPUT;
      output: OUTPUT;
      errorText?: never;
      callProviderMetadata?: ProviderMetadata;
      resultProviderMetadata?: ProviderMetadata;
      preliminary?: boolean;
      approval?: {
        id: string;
        approved: true;
        descriptor?: unknown;
        requestReason?: string;
        reason?: string;
        data?: JSONObject;
        isAutomatic?: boolean;
        signature?: string;
        inputSchemaInput?: unknown;

        createdAt: number;
        approvedAt?: number;
      };
    }
  | {
      state: "output-error";
      input: INPUT | undefined;
      rawInput?: unknown;
      output?: never;
      errorText: string;
      callProviderMetadata?: ProviderMetadata;
      resultProviderMetadata?: ProviderMetadata;
      approval?: {
        id: string;
        approved: true;
        descriptor?: unknown;
        requestReason?: string;
        reason?: string;
        data?: JSONObject;
        isAutomatic?: boolean;
        signature?: string;
        inputSchemaInput?: unknown;

        createdAt: number;
        approvedAt?: number;
      };
    }
  | {
      state: "output-denied";
      input: INPUT;
      output?: never;
      errorText?: never;
      callProviderMetadata?: ProviderMetadata;
      approval: {
        id: string;
        approved: false;
        descriptor?: unknown;
        requestReason?: string;
        reason?: string;
        data?: JSONObject;
        isAutomatic?: boolean;
        signature?: string;
        inputSchemaInput?: unknown;

        createdAt: number;
        approvedAt: number;
      };
    }
);

/**
 * An invocation of a known tool. Deriving it from the tool itself is what lets
 * a UI component be written per tool without knowing the tool name.
 */
type AgentToolInvocation<TOOL extends UITool | Tool> = AgentToolInvocationBase<
  asUITool<TOOL>["input"],
  asUITool<TOOL>["output"]
>;
export type AgentStaticToolPart<TOOLS extends ToolSet = ToolSet> = ValueOf<{
  [NAME in keyof TOOLS & string]: {
    type: `tool-${NAME}`;
    rawInput: string;
  } & AgentToolInvocation<TOOLS[NAME]>;
}>;
export function isAgentStaticToolPart<TOOLS extends ToolSet>(
  part: AgentPart<TOOLS>
): part is AgentStaticToolPart<TOOLS> {
  return part.type.startsWith("tool-");
}
export type AgentDynamicToolPart = AgentToolInvocationBase<unknown, unknown> & {
  type: "dynamic-tool";
  /**
   * Name of the tool that is being called.
   */
  toolName: string;

  rawInput: string;
};
export function isAgentDynamicToolPart<TOOLS extends ToolSet>(
  part: AgentPart<TOOLS>
): part is AgentDynamicToolPart {
  return part.type === "dynamic-tool";
}
export type AgentToolPart<TOOLS extends ToolSet = ToolSet> =
  | AgentStaticToolPart<TOOLS>
  | AgentDynamicToolPart;
export function isAgentToolPart<TOOLS extends ToolSet>(
  part: AgentPart<TOOLS>
): part is AgentToolPart<TOOLS> {
  return isAgentStaticToolPart(part) || isAgentDynamicToolPart(part);
}

/**
 * Returns the name of the static tool.
 *
 * The possible values are the keys of the tool set.
 */
export function getStaticToolName<TOOLS extends ToolSet>(
  part: AgentStaticToolPart<TOOLS>
): keyof TOOLS {
  return part.type.split("-").slice(1).join("-") as keyof TOOLS;
}

/**
 * Returns the name of the tool (static or dynamic).
 *
 * This function will not restrict the name to the keys of the tool set.
 * If you need to restrict the name to the keys of the tool set, use `getStaticToolName` instead.
 */
export function getToolName(part: AgentToolPart): string {
  return isAgentDynamicToolPart(part) ? part.toolName : getStaticToolName(part);
}

/**
 * Parts a user step can hold.
 */
export type AgentUserPart = AgentTextPart | AgentFilePart;
/**
 * Parts an assistant step can hold. Reasoning and tool activity only exist on
 * the assistant side, files only on the user side.
 */
export type AgentAssistantPart<TOOLS extends ToolSet> =
  | AgentTextPart
  | AgentCustomContentPart
  | AgentReasoningPart
  | AgentStaticToolPart<TOOLS>
  | AgentDynamicToolPart
  | AgentSessionTitlePart;
/**
 * Every part a step can hold, whichever side produced it.
 *
 * Note that the discriminant here is `type`, not the `kind` used by steps and
 * turns: parts line up with `UIMessage` parts, whose discriminant is fixed by
 * the AI SDK, while the step and turn levels are ours.
 */
export type AgentPart<TOOLS extends ToolSet> =
  | AgentUserPart
  | AgentAssistantPart<TOOLS>
  | AgentCompactionPart;

export type StepMetadata = Record<string, any> & {
  /**
   * Unknown while the step is streaming, for the same reason as `usage`.
   */
  performance?: StepResultPerformance;
};

/**
 * Identity and wall-clock bounds, held by both steps and turns: each level
 * starts at a known time, may still be running, and is addressable by id.
 *
 * `id` is unique within its own level — a step's id is never the id of the
 * turn containing it. A user turn wraps exactly one user step, so those two
 * ids sit next to each other and are easy to mix up.
 */
export type AgentStepBase = AgentStepStatus & {
  /**
   * A unique identifier for the step (or turn).
   */
  id: string;

  /**
   * Epoch (ms)
   */
  createdAt: number;

  /**
   * Epoch (ms). Absent while the step (or turn) is still running.
   */
  completedAt?: number;

  usage?: LanguageModelUsage;

  /**
   * Unknown while the step is streaming, which is why they are optional: the
   * step object exists — and is rendered — before the model has finished, and
   * `status` says whether they are supposed to be there yet.
   */
  finishReason?: FinishReason;
  rawFinishReason?: string;
  providerMetadata?: ProviderMetadata;

  metadata?: StepMetadata;
};

export type AgentTurnBase = AgentTurnStatus & {
  /**
   * A unique identifier for the step (or turn).
   */
  id: string;

  /**
   * Epoch (ms)
   */
  createdAt: number;

  /**
   * Epoch (ms). Absent while the step (or turn) is still running.
   */
  completedAt?: number;

  usage?: LanguageModelUsage;

  /**
   * Unknown while the step is streaming, for the same reason as `usage`.
   */
  performance?: StepResultPerformance;

  /**
   * Unknown while the step is streaming, which is why they are optional: the
   * step object exists — and is rendered — before the model has finished, and
   * `status` says whether they are supposed to be there yet.
   */
  finishReason?: FinishReason;
  rawFinishReason?: string;
  providerMetadata?: ProviderMetadata;
};

/**
 * How a step or turn ended.
 *
 * The stream reports `abort` and `error` as parts with no turn or step id, so
 * landing the outcome here is the only place the reason survives into the
 * persisted transcript — without it, "aborted" and "still streaming" are both
 * just an absent `endTime`, and the two cannot be told apart.
 *
 * The values deliberately reuse the `streaming` / `done` vocabulary of
 * `AgentTextPart["state"]`. Only assistant steps and turns carry a status:
 * user-side content is complete the moment it exists.
 *
 * `wait_review` is a turn's word rather than a step's — the step that asked for
 * something held did stream to its end, and it is the turn that stops there,
 * with calls the user has yet to answer.
 */
export type AgentStepStatus =
  | { status: "streaming" }
  | { status: "done" }
  | { status: "wait_review" }
  | { status: "aborted"; abortReason?: string }
  | { status: "error"; error: unknown };
export type AgentTurnStatus = AgentStepStatus;

export type AgentUserStep = AgentStepBase & {
  /**
   * The type of the step.
   */
  type: "user";

  content: AgentUserPart[];
};

/**
 * 回合运行中插入的一条引导消息。
 *
 * 它不是独立的 user turn，而是当前 assistant turn 里的一个 step：用户在回复
 * 过程中补一句话，模型在下一步读到它。位置就是它生效的地方，渲染也因此在
 * assistant turn 的步骤链里。
 *
 * id 直接使用 Inbox 行的 id，客户端据此在 `turn.steer` 到达时移除队列项。
 */
export type AgentSteeringStep = AgentStepBase & {
  type: "steering";

  content: AgentUserPart[];
};

export type AgentSessionTitleStep = AgentStepBase & {
  /**
   * The type of the step.
   */
  type: "session.title";

  content: AgentSessionTitlePart[];

  /**
   * The model that produced this step. Steps of one turn can disagree here
   * when the runtime falls back to another model mid-turn.
   */
  model: string;
};

/**
 * 压缩标记。自动压缩时，它在 turn content 中的位置就是边界：投影扫到它时
 * 会重置为 checkpoint。手工压缩的标记 turn 则线性追加在 branch 末尾，真正的
 * 切点由记录里的 `retainedFromTurnId` 给出。
 *
 * 它要么位于 assistant turn 内（自动压缩，就在模型上下文被切掉的位置），
 * 要么位于独立的 compaction turn 内（手工压缩）。
 */
export type AgentCompactionStep = AgentStepBase & {
  type: "compaction";

  content: AgentCompactionPart[];

  /** 生成摘要的模型。 */
  model: string;
};

export type AgentAssistantStep<TOOLS extends ToolSet> = AgentStepBase & {
  /**
   * The type of the step.
   */
  type: "assistant";

  content: AgentAssistantPart<TOOLS>[];

  /**
   * The model that produced this step. Steps of one turn can disagree here
   * when the runtime falls back to another model mid-turn.
   */
  model: string;
};

/**
 * A step of a turn. Discriminated by `kind`, so a consumer that switches over
 * it gets exhaustiveness checking when a new type of step is introduced.
 */
export type AgentStep<TOOLS extends ToolSet> =
  | AgentUserStep
  | AgentAssistantStep<TOOLS>
  | AgentCompactionStep
  | AgentSteeringStep
  | AgentSessionTitleStep;

export function isAgentSteeringStep<TOOLS extends ToolSet>(
  step: AgentStep<TOOLS>
): step is AgentSteeringStep {
  return step.type === "steering";
}

export type AgentUserTurn = AgentTurnBase & {
  /**
   * The type of the turn.
   */
  type: "user";

  content: AgentUserStep[];
};
export function isAgentUserTurn<TOOLS extends ToolSet>(
  part: AgentTurn<TOOLS>
): part is AgentUserTurn {
  return part.type === "user";
}
export type AgentAssistantTurn<TOOLS extends ToolSet> = AgentTurnBase & {
  /**
   * The type of the turn.
   */
  type: "assistant";

  /**
   * 这条 turn 按顺序排列的 steps。一条 turn 就是一次 assistant 回复：先是模型
   * step，然后每轮工具调用一个 step，直到模型不再调用工具。
   *
   * 中间可能插入一个压缩 step：自动压缩就地切掉上下文，投影会把它之后的
   * 所有 step 当作保留段。
   *
   * 也可能插入一个 steering step：回合运行中用户补的一句话，模型在下一步
   * 读到它。它属于当前回复，不拆成独立的 user turn。
   */
  content: (
    | AgentAssistantStep<TOOLS>
    | AgentCompactionStep
    | AgentSteeringStep
  )[];
};

/**
 * 只用来承载压缩标记的 turn（手工 `/compact`）。
 *
 * 它是普通的 branch 节点，并且总是追加到末尾、成为新的 active head。它不代表
 * 物理切点：切点写在 `CompactionRecord.retainedFromTurnId` 里，投影据此从保留段
 * 起点重建；全量压缩没有这个字段，标记之前的 turn 全部被 checkpoint 替代。
 */
export type AgentCompactionTurn = AgentTurnBase & {
  type: "compaction";
  content: AgentCompactionStep[];
};

export type AgentTurn<TOOLS extends ToolSet = ToolSet> =
  | AgentUserTurn
  | AgentAssistantTurn<TOOLS>
  | AgentCompactionTurn;
