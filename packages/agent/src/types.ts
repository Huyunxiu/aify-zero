import type { FinishReason, LanguageModelUsage, UIMessage } from "ai";

import type {
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
  totalUsage?: LanguageModelUsage;
  finishReason?: FinishReason;
  rawFinishReason?: string;
};

export type AgentUIDataParts = Record<string, unknown>;

export type AgentUITools = {
  "delete-file": DeleteFileToolType;
  "edit-file": EditFileToolType;
  grep: GrepToolType;
  glob: GlobToolType;
  "read-file": ReadFileToolType;
  "write-file": WriteFileToolType;
  "web-fetch": WebFetchToolType;
  "load-skill": LoadSkillToolType;
};

export type AgentUIMessage = UIMessage<
  AgentUIMetadata,
  AgentUIDataParts,
  AgentUITools
>;
