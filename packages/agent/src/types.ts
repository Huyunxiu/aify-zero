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
  "web-fetch": WebFetchToolType;
  "write-file": WriteFileToolType;
};

export type AgentUIMessage = UIMessage<
  AgentUIMetadata,
  AgentUIDataParts,
  AgentUITools
>;
