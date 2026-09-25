import type {
  BashToolType,
  DeleteFileToolType,
  EditFileToolType,
  GlobToolType,
  GrepToolType,
  ReadFileToolType,
  WebFetchToolType,
  WriteFileToolType,
} from "@workspace/agent/tools/index";
import type { LoadSkillToolType } from "@workspace/agent/tools/load-skill";
import type {
  FinishReason,
  InferUITool,
  LanguageModelUsage,
  ModelMessage,
  UIMessage,
} from "ai";

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
