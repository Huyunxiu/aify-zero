import type {
  FinishReason,
  LanguageModelUsage,
  ModelMessage,
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

export type AgentUIMetadata = {
  createdAt?: number;
  usage?: LanguageModelUsage;
  totalUsage?: LanguageModelUsage;
  finishReason?: FinishReason;
  rawFinishReason?: string;
};

export type AgentUIDataParts = {
  "session:title": string;
  "compaction:start": {
    createdAt: number;
  };
  "compaction:end": {
    compacted: boolean;
    messages: ModelMessage[];
    createdAt: number;
  };
};

export type AgentUITools = {
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
