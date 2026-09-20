import type {
  CallWarning,
  FinishReason,
  InferUITool,
  LanguageModelUsage,
  ModelMessage,
  ProviderMetadata,
  StaticToolOutputDenied,
  StepResultPerformance,
  ToolSet,
  TypedToolCall,
  TypedToolError,
  TypedToolResult,
  UIMessage,
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

type TextStreamTextStartPart = {
  type: "text.start";
  id: string;
  providerMetadata?: ProviderMetadata;
};
type TextStreamTextDeltaPart = {
  type: "text.delta";
  id: string;
  providerMetadata?: ProviderMetadata;
  text: string;
};
type TextStreamTextEndPart = {
  type: "text.end";
  id: string;
  providerMetadata?: ProviderMetadata;
};
type TextStreamReasoningStartPart = {
  type: "reasoning.start";
  id: string;
  providerMetadata?: ProviderMetadata;
};
type TextStreamReasoningEndPart = {
  type: "reasoning.end";
  id: string;
  providerMetadata?: ProviderMetadata;
};
type TextStreamReasoningDeltaPart = {
  type: "reasoning.delta";
  providerMetadata?: ProviderMetadata;
  id: string;
  text: string;
};
type TextStreamToolInputStartPart = {
  type: "tool.input-start";
  id: string;
  toolName: string;
  providerMetadata?: ProviderMetadata;
  toolMetadata?: JSONObject;
  providerExecuted?: boolean;
  dynamic?: boolean;
  title?: string;
};
type TextStreamToolInputEndPart = {
  type: "tool.input-end";
  id: string;
  providerMetadata?: ProviderMetadata;
};
type TextStreamToolInputDeltaPart = {
  type: "tool.input-delta";
  id: string;
  delta: string;
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
type RenamePartType<T, TYPE extends string> = T extends unknown
  ? Omit<T, "type"> & { type: TYPE }
  : never;

type TextStreamToolCallPart<TOOLS extends ToolSet> = RenamePartType<
  TypedToolCall<TOOLS>,
  "tool.call"
>;
type TextStreamToolResultPart<TOOLS extends ToolSet> = RenamePartType<
  TypedToolResult<TOOLS>,
  "tool.result"
>;
type TextStreamToolErrorPart<TOOLS extends ToolSet> = RenamePartType<
  TypedToolError<TOOLS>,
  "tool.error"
>;
type TextStreamToolOutputDeniedPart<TOOLS extends ToolSet> = RenamePartType<
  StaticToolOutputDenied<TOOLS>,
  "tool.output-denied"
>;
/**
 * The turn and step a boundary part belongs to. Every part always belongs to
 * exactly one of each, so both are stamped even where the other is implied.
 */
type TextStreamIds = {
  turnId: string;
  stepId: string;
};
type TextStreamStartStepPart = {
  type: "step.start";
  warnings: CallWarning[];
} & TextStreamIds;
type TextStreamFinishStepPart = {
  type: "step.finish";
  usage: LanguageModelUsage;
  performance: StepResultPerformance;
  finishReason: FinishReason;
  rawFinishReason: string | undefined;
  providerMetadata: ProviderMetadata | undefined;
} & TextStreamIds;
type TextStreamStartTurnPart = {
  type: "turn.start";
} & TextStreamIds;
type TextStreamFinishTurnPart = {
  type: "turn.finish";
  finishReason: FinishReason;
  rawFinishReason: string | undefined;
  totalUsage: LanguageModelUsage;
} & TextStreamIds;
type TextStreamAbortPart = {
  type: "abort";
  reason?: string;
};
type TextStreamErrorPart = {
  type: "error";
  error: unknown;
};
export type AgentStreamPart<TOOLS extends ToolSet> =
  | TextStreamTextStartPart
  | TextStreamTextEndPart
  | TextStreamTextDeltaPart
  | TextStreamReasoningStartPart
  | TextStreamReasoningEndPart
  | TextStreamReasoningDeltaPart
  | TextStreamToolInputStartPart
  | TextStreamToolInputEndPart
  | TextStreamToolInputDeltaPart
  | TextStreamToolCallPart<TOOLS>
  | TextStreamToolResultPart<TOOLS>
  | TextStreamToolErrorPart<TOOLS>
  | TextStreamToolOutputDeniedPart<TOOLS>
  | TextStreamStartStepPart
  | TextStreamFinishStepPart
  | TextStreamStartTurnPart
  | TextStreamFinishTurnPart
  | TextStreamAbortPart
  | TextStreamErrorPart;
