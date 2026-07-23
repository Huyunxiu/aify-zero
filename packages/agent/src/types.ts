import type { FinishReason, LanguageModelUsage, UIMessage } from "ai";

import type {
  DeleteFileToolType,
  EditFileToolType,
  GrepToolType,
  ReadFileToolType,
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
  "read-file": ReadFileToolType;
  "write-file": WriteFileToolType;
};

export type AgentUIMessage = UIMessage<
  AgentUIMetadata,
  AgentUIDataParts,
  AgentUITools
>;
