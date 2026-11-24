import {
  botCompactionOverrideSchema,
  botEffortSchema,
  botMcpConfigSchema,
  botModelRefSchema,
  botSandboxConfigSchema,
  botSkillsConfigSchema,
  botToolGroupsSchema,
} from "@workspace/agent-client";
import { mcpServerSchema } from "@workspace/agent/mcp";
import z from "zod";

import { approvalPolicySchema } from "../session/session.schema";

const envKeySchema = z.string().trim().min(1);
const trimmedOptionalText = z.string().trim().optional();
const trimmedNullableText = z.string().trim().nullable().optional();

export const createBotInputSchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: trimmedOptionalText,
  instructions: trimmedOptionalText,
  defaultModel: botModelRefSchema.nullable().optional(),
  defaultEffort: botEffortSchema.nullable().optional(),
  defaultProjectId: z.string().min(1).nullable().optional(),
  defaultApprovalPolicy: approvalPolicySchema.optional(),
  includeGlobalContext: z.boolean().optional(),
  skills: botSkillsConfigSchema.optional(),
  mcp: botMcpConfigSchema.optional(),
  toolGroups: botToolGroupsSchema.optional(),
  sandbox: botSandboxConfigSchema.optional(),
  compaction: botCompactionOverrideSchema.nullable().optional(),
  env: z.record(envKeySchema, z.string()).optional(),
});

export const updateBotInputSchema = z.object({
  botId: z.string().min(1),
  name: z.string().trim().min(1).max(100).optional(),
  description: trimmedNullableText,
  instructions: trimmedNullableText,
  defaultModel: botModelRefSchema.nullable().optional(),
  defaultEffort: botEffortSchema.nullable().optional(),
  defaultProjectId: z.string().min(1).nullable().optional(),
  defaultApprovalPolicy: approvalPolicySchema.optional(),
  includeGlobalContext: z.boolean().optional(),
  skills: botSkillsConfigSchema.optional(),
  mcp: botMcpConfigSchema.optional(),
  toolGroups: botToolGroupsSchema.optional(),
  sandbox: botSandboxConfigSchema.optional(),
  compaction: botCompactionOverrideSchema.nullable().optional(),
  /** Key updates: string writes/overwrites the value; null deletes the key. */
  envPatch: z.record(envKeySchema, z.string().nullable()).optional(),
});

export const botIdInputSchema = z.object({
  botId: z.string().min(1),
});

export const deleteBotInputSchema = z.object({
  botId: z.string().min(1),
  deleteFiles: z.boolean().optional(),
});

export const testBotMcpInputSchema = z.object({
  botId: z.string().min(1),
  server: mcpServerSchema,
});

export type CreateBotInput = z.infer<typeof createBotInputSchema>;
export type UpdateBotInput = z.infer<typeof updateBotInputSchema>;
