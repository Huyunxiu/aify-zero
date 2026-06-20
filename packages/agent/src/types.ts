import type { FinishReason, LanguageModelUsage, UIMessage } from "ai";

import type {
  DeleteFileToolType,
  EditFileToolType,
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
  "read-file": ReadFileToolType;
  "write-file": WriteFileToolType;
};

export type AgentUIMessage = UIMessage<
  AgentUIMetadata,
  AgentUIDataParts,
  AgentUITools
>;
