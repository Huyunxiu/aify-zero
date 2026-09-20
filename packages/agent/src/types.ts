import type {
  CallWarning,
  DeepPartial,
  FinishReason,
  InferUITool,
  LanguageModelUsage,
  ModelMessage,
  ProviderMetadata,
  ProviderReference,
  StaticToolOutputDenied,
  StepResultPerformance,
  Tool,
  ToolSet,
  TypedToolCall,
  TypedToolError,
  TypedToolResult,
  UIMessage,
  UITool,
  UITools,
} from "ai";

import type {
  BashToolType,
  DeleteFileToolType,
  EditFileToolType,
  GlobToolType,
  GrepToolType,
  ReadFileToolType,
  WebFetchToolType,
  WriteFileToolType,
} from "./tools";
import type { LoadSkillToolType } from "./tools/load-skill";

/**
 * A JSON value can be a string, number, boolean, object, array, or null.
 * JSON values can be serialized and deserialized by the JSON.stringify and JSON.parse methods.
 */
type JSONValue = null | string | number | boolean | JSONObject | JSONArray;
type JSONObject = {
  [key: string]: JSONValue | undefined;
};
type JSONArray = JSONValue[];

export type AgentUIMetadata = {
  createdAt?: number;
  usage?: LanguageModelUsage;
  totalUsage?: LanguageModelUsage;
  finishReason?: FinishReason;
  rawFinishReason?: string;
};

export type AgentUIDataParts = {
  "session:title": {
    title: string;
    createdAt: number;
  };
  "compaction:start": {
    createdAt: number;
  };
  "compaction:end": {
    compacted: boolean;
    messages: ModelMessage[];
    createdAt: number;
  };
  "command:compact": {};
};

export type AgentToolSet = {
  "delete-file": DeleteFileToolType;
  "edit-file": EditFileToolType;
  grep: GrepToolType;
  glob: GlobToolType;
  "read-file": ReadFileToolType;
  "write-file": WriteFileToolType;
  "web-fetch": WebFetchToolType;
  "load-skill": LoadSkillToolType;
  bash: BashToolType;
};

export type AgentUITools = {
  "delete-file": InferUITool<DeleteFileToolType>;
  "edit-file": InferUITool<EditFileToolType>;
  grep: InferUITool<GrepToolType>;
  glob: InferUITool<GlobToolType>;
  "read-file": InferUITool<ReadFileToolType>;
  "write-file": InferUITool<WriteFileToolType>;
  "web-fetch": InferUITool<WebFetchToolType>;
  "load-skill": InferUITool<LoadSkillToolType>;
  bash: InferUITool<BashToolType>;
};

export type AgentUIMessage = UIMessage<
  AgentUIMetadata,
  AgentUIDataParts,
  AgentUITools
>;

/**
 * Compaction configuration stored on the session.
 */
export interface CompactionConfig {
  lastKnownInputTokens?: number;
  lastKnownPromptMessageCount?: number;
  recentWindowSize: number;
  threshold: number;
  thresholdPercent?: number;
}

export type AgentRuntimeContext = Record<string, unknown>;

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
type TextStreamCompactionStartEvent = TextStreamEventBase & {
  type: "compaction.start";
  id: string;
};
type TextStreamCompactionEndEvent = TextStreamEventBase & {
  type: "compaction.end";
  id: string;
  compacted: boolean;
  messages: ModelMessage[];
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
type TextStreamStartStepEvent = TextStreamEventBase & {
  type: "step.start";
  warnings: CallWarning[];
};
type TextStreamFinishStepEvent = TextStreamEventBase & {
  type: "step.finish";
  usage: LanguageModelUsage;
  performance: StepResultPerformance;
  finishReason: FinishReason;
  rawFinishReason: string | undefined;
  providerMetadata: ProviderMetadata | undefined;
};
type TextStreamStartTurnEvent = TextStreamEventBase & {
  type: "turn.start";
};
type TextStreamFinishTurnEvent = TextStreamEventBase & {
  type: "turn.finish";
  finishReason: FinishReason;
  rawFinishReason: string | undefined;
  totalUsage: LanguageModelUsage;
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
  | TextStreamReasoningStartEvent
  | TextStreamReasoningEndEvent
  | TextStreamReasoningDeltaEvent
  | TextStreamToolInputStartEvent
  | TextStreamToolInputEndEvent
  | TextStreamToolInputDeltaEvent
  | TextStreamToolCallEvent<TOOLS>
  | TextStreamToolResultEvent<TOOLS>
  | TextStreamToolErrorEvent<TOOLS>
  | TextStreamToolOutputDeniedEvent<TOOLS>
  | TextStreamStartStepEvent
  | TextStreamFinishStepEvent
  | TextStreamStartTurnEvent
  | TextStreamFinishTurnEvent
  | TextStreamAbortEvent
  | TextStreamErrorEvent
  | TextStreamCompactionStartEvent
  | TextStreamCompactionEndEvent;

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
   * The provider metadata.
   */
  providerMetadata?: ProviderMetadata;
};
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
   * The provider metadata.
   */
  providerMetadata?: ProviderMetadata;
};
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
} & (
  | {
      state: "input-streaming";
      input?: DeepPartial<INPUT> | undefined;
      output?: never;
      errorText?: never;
      callProviderMetadata?: ProviderMetadata;
    }
  | {
      state: "input-available";
      input: INPUT;
      output?: never;
      errorText?: never;
      callProviderMetadata?: ProviderMetadata;
    }
  | {
      state: "output-available";
      input: INPUT;
      output: OUTPUT;
      errorText?: never;
      callProviderMetadata?: ProviderMetadata;
      resultProviderMetadata?: ProviderMetadata;
      preliminary?: boolean;
    }
  | {
      state: "output-error";
      input: INPUT | undefined;
      rawInput?: unknown;
      output?: never;
      errorText: string;
      callProviderMetadata?: ProviderMetadata;
      resultProviderMetadata?: ProviderMetadata;
    }
  | {
      state: "output-denied";
      input: INPUT;
      output?: never;
      errorText?: never;
      callProviderMetadata?: ProviderMetadata;
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
export type AgentToolPart<TOOLS extends UITools = UITools> = ValueOf<{
  [NAME in keyof TOOLS & string]: {
    type: `tool-${NAME}`;
  } & AgentToolInvocation<TOOLS[NAME]>;
}>;
export type AgentDynamicToolPart = AgentToolInvocationBase<unknown, unknown> & {
  type: "dynamic-tool";
  /**
   * Name of the tool that is being called.
   */
  toolName: string;
};
export type AgentCompactionPart = {
  id: string;
  type: "compaction";
  compacted: boolean;
  messages: ModelMessage[];
  /**
   * The state of the reasoning part.
   */
  state?: "streaming" | "done";
};
/**
 * Parts a user step can hold.
 */
export type AgentUserPart = AgentTextPart | AgentFilePart;
/**
 * Parts an assistant step can hold. Reasoning and tool activity only exist on
 * the assistant side, files only on the user side.
 */
export type AgentAssistantPart<TOOLS extends UITools> =
  | AgentTextPart
  | AgentReasoningPart
  | AgentToolPart<TOOLS>
  | AgentDynamicToolPart;
/**
 * Every part a step can hold, whichever side produced it.
 *
 * Note that the discriminant here is `type`, not the `kind` used by steps and
 * turns: parts line up with `UIMessage` parts, whose discriminant is fixed by
 * the AI SDK, while the step and turn levels are ours.
 */
export type AgentPart<TOOLS extends UITools> =
  | AgentUserPart
  | AgentAssistantPart<TOOLS>;

/**
 * Identity and wall-clock bounds, held by both steps and turns: each level
 * starts at a known time, may still be running, and is addressable by id.
 *
 * `id` is unique within its own level — a step's id is never the id of the
 * turn containing it. A user turn wraps exactly one user step, so those two
 * ids sit next to each other and are easy to mix up.
 */
export type AgentStepBase = {
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
};

export type AgentTurnBase = {
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

  /**
   * Usage aggregated across the turn's steps with the AI SDK's usage addition
   * helper, not simply the last step's usage. Named to match the `turn.finish`
   * stream part and `AgentUIMetadata.totalUsage`.
   */
  totalUsage?: LanguageModelUsage;
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
 */
export type AgentStepStatus =
  | { status: "streaming" }
  | { status: "done" }
  | { status: "aborted"; abortReason?: string }
  | { status: "error"; error: unknown };

export type AgentUserStep = AgentStepBase & {
  /**
   * The type of the step.
   */
  type: "user";

  content: AgentUserPart[];
};

export type AgentAssistantStep<TOOLS extends UITools> = AgentStepBase &
  AgentStepStatus & {
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

    /**
     * Usage of this step alone. Turn-level totals live on
     * `AgentAssistantTurn.totalUsage`.
     */
    usage: LanguageModelUsage;

    performance: StepResultPerformance;

    /**
     * Unknown while the step is streaming, which is why they are optional: the
     * step object exists — and is rendered — before the model has finished, and
     * `status` says whether they are supposed to be there yet.
     */
    finishReason: FinishReason;
    rawFinishReason: string;
    providerMetadata?: ProviderMetadata;
  };

export type AgentCompactionStep = AgentStepBase &
  AgentStepStatus & {
    /**
     * The type of the step.
     */
    type: "compaction";

    content: AgentCompactionPart[];

    /**
     * The model that produced this step. Steps of one turn can disagree here
     * when the runtime falls back to another model mid-turn.
     */
    model: string;

    /**
     * Usage of this step alone. Turn-level totals live on
     * `AgentAssistantTurn.totalUsage`.
     */
    usage: LanguageModelUsage;

    performance: StepResultPerformance;

    /**
     * Unknown while the step is streaming, which is why they are optional: the
     * step object exists — and is rendered — before the model has finished, and
     * `status` says whether they are supposed to be there yet.
     */
    finishReason: FinishReason;
    rawFinishReason: string;
    providerMetadata?: ProviderMetadata;
  };

/**
 * A step of a turn. Discriminated by `kind`, so a consumer that switches over
 * it gets exhaustiveness checking when a new type of step is introduced.
 */
export type AgentStep<TOOLS extends UITools> =
  | AgentUserStep
  | AgentAssistantStep<TOOLS>;

export type AgentUserTurn = AgentTurnBase & {
  /**
   * The type of the turn.
   */
  type: "user";

  content: AgentUserStep[];
};
export type AgentAssistantTurn<TOOLS extends UITools> = AgentTurnBase &
  AgentStepStatus & {
    /**
     * The type of the turn.
     */
    type: "assistant";

    /**
     * The steps of the turn in order. One turn is one assistant reply: the model
     * step, then a step per round of tool calls, until it stops calling tools.
     */
    content: (AgentAssistantStep<TOOLS> | AgentCompactionStep)[];
  };
export type AgentCompactionTurn = AgentTurnBase &
  AgentStepStatus & {
    /**
     * The type of the turn.
     */
    type: "compaction";

    /**
     * The steps of the turn in order. One turn is one assistant reply: the model
     * step, then a step per round of tool calls, until it stops calling tools.
     */
    content: AgentCompactionStep[];
  };

export type AgentTurn<TOOLS extends UITools> =
  | AgentUserTurn
  | AgentAssistantTurn<TOOLS>
  | AgentCompactionTurn;
