import type { Tool } from "ai";

import type { QuestionnaireAnswers } from "./questionnaire";

/** 一个工具怎么让模型看见。 */
export type ToolExposure = "direct" | "deferred";

/**
 * 工具结果的公共信封。
 *
 * 它属于协议：服务端写 part，界面读 part，两边用同一份形状。
 */
export type ToolOutputCode = "ok" | "error";

export type ToolOutput<
  TOutput = string,
  TMetadata = Record<string, unknown>,
> = {
  metadata?: TMetadata;
  output: TOutput;
  code: ToolOutputCode;
  message?: string | null;
};

/** 文件附件；read-file 和 load-skill 会带。 */
export type FileAttachment = {
  type: "file-data";
  data: string;
  mediaType: string;
  filename?: string;
};

/** 公共的任务投影；jobs 工具的 metadata 用它。 */
export type PublicJob = {
  id: string;
  kind: string;
  label: string;
  status: "running" | "stopping" | "completed" | "killed" | "failed";
  detail?: string;
  startedAt: number;
  finishedAt?: number;
};

/** read-file 和 load-skill 共用的 metadata 变体。 */
export type FileReadMetadata =
  | { type: "miss"; filepath: string }
  | {
      type: "directory";
      filepath: string;
      truncated: boolean;
      entries: string[];
      limit: number;
      offset: number;
      totalEntries: number;
    }
  | {
      type: "file";
      mime: string;
      text: string;
      filepath: string;
      truncated: boolean;
      limit: number;
      offset: number;
      totalLines?: number;
    }
  | { type: "attachments"; filepath: string; mime: string }
  | { type: "binary-file"; filepath: string; mime: string };

export type DeleteFileInput = { path: string; recursive: boolean };
export type DeleteFileMetadata = {
  filepath: string;
  kind: "file" | "directory";
};
export type DeleteFileOutput = ToolOutput<string, DeleteFileMetadata>;

export type EditFileInput = {
  path: string;
  edits: { oldText: string; newText: string }[];
};
export type EditFileMetadata = {
  filepath: string;
  replacements: number;
  linesAdded: number;
  linesRemoved: number;
  diff: string;
  firstChangedLine?: number;
};
export type EditFileOutput = ToolOutput<string, EditFileMetadata>;

export type GlobInput = {
  pattern: string;
  path?: string;
  limit: number;
};
export type GlobMetadata = {
  count: number;
  path: string;
  truncatedByBytes: boolean;
  truncatedByLines: boolean;
  exitCode: number | null;
};
export type GlobOutput = ToolOutput<string, GlobMetadata>;

export type GrepInput = {
  pattern: string;
  path?: string;
  glob?: string;
  context: number;
  ignoreCase: boolean;
  limit: number;
  literal: boolean;
};
export type GrepMetadata = {
  matchCount: number;
  path: string;
  truncatedByBytes: boolean;
  truncatedByLines: boolean;
  exitCode: number | null;
};
export type GrepOutput = ToolOutput<string, GrepMetadata>;

export type ReadFileInput = {
  path: string;
  limit?: number;
  offset?: number;
};
export type ReadFileOutput = ToolOutput<string, FileReadMetadata> & {
  attachments?: FileAttachment[];
};

export type WriteFileInput = { content: string; path: string };
export type WriteFileMetadata = {
  filepath: string;
  created: boolean;
  bytes: number;
  lines: number;
};
export type WriteFileOutput = ToolOutput<string, WriteFileMetadata>;

export type WebFetchInput = {
  url: string;
  format: "html" | "markdown" | "text";
  timeout?: number;
};
export type WebFetchMetadata = {
  title: string;
  url: string;
  contentType: string;
  truncated: boolean;
};
export type WebFetchOutput = ToolOutput<string, WebFetchMetadata>;

export type LoadSkillInput = {
  skill: string;
  path?: string;
  limit?: number;
  offset?: number;
};
export type LoadSkillOutput = ToolOutput<string, FileReadMetadata> & {
  attachments?: FileAttachment[];
};

export type JobOutputInput = {
  jobId: string;
  wait?: boolean;
  timeoutMs?: number;
};
export type JobOutputMetadata = { job: PublicJob };
export type JobOutputOutput = ToolOutput<string, JobOutputMetadata>;

export type JobListInput = Record<string, never>;
export type JobListOutput = ToolOutput<string, { count: number }>;

export type JobKillInput = { jobId: string; reason?: string };
export type JobKillMetadata = {
  outcome: "cancellation-requested" | "already-finished";
  job: PublicJob;
};
export type JobKillOutput = ToolOutput<string, JobKillMetadata>;

export type QuestionnaireChoice = {
  description?: string;
  label: string;
  value: string;
};

export type QuestionnaireQuestion = {
  allowOther?: boolean;
  choices?: QuestionnaireChoice[];
  description?: string;
  id: string;
  multiple?: boolean;
  prompt: string;
  required?: boolean;
};

export type QuestionnaireToolInput = {
  description?: string;
  questions: QuestionnaireQuestion[];
  title?: string;
};

export type QuestionnaireToolMetadata = {
  status: "submitted" | "unanswered";
  title?: string;
  total: number;
  answered: number;
  answers: QuestionnaireAnswers;
};
export type QuestionnaireToolOutput = ToolOutput<
  string,
  QuestionnaireToolMetadata
>;

export type ShellToolInput = {
  command: string;
  timeout?: number;
  workdir?: string;
  description: string;
  run_in_background?: boolean;
};

export type ShellForegroundMetadata = {
  kind: "foreground";
  exitCode: number | null;
  signal: string | null;
  timeout: boolean;
  aborted: boolean;
  timeoutMs: number;
  durationMs: number;
  truncated: boolean;
  spillPath?: string;
};

export type ShellBackgroundMetadata = {
  kind: "background";
  jobId: string;
  cwd: string;
};

export type ShellToolMetadata =
  | ShellForegroundMetadata
  | ShellBackgroundMetadata;

export type ShellToolOutput = ToolOutput<string, ShellToolMetadata>;

export type TaskToolInput = {
  subagent_type: string;
  description: string;
  prompt: string;
};
export type TaskToolMetadata = {
  status: string;
  sessionId?: string;
};
export type TaskToolOutput = ToolOutput<string, TaskToolMetadata>;

export type SearchToolsInput = { query: string; limit?: number };
export type SearchToolsResult = {
  tool: string;
  description: string;
  signature: string;
};
export type CatalogUnavailable = { server: string; reason: string };
export type SearchToolsOutput = {
  results: SearchToolsResult[];
  catalogSize: number;
  remaining: number;
  unavailable?: CatalogUnavailable[];
};

export type CallToolInput = {
  name: string;
  input: Record<string, unknown>;
};

/**
 * 会话里所有工具的名字与它们的入参/出参形状。
 *
 * 这是协议类型：界面渲染工具 part 时读它，运行时不依赖它。新增工具时，这里
 * 和工具实现要一起改。
 */
export type AgentToolSet = {
  "delete-file": Tool<DeleteFileInput, DeleteFileOutput>;
  "edit-file": Tool<EditFileInput, EditFileOutput>;
  glob: Tool<GlobInput, GlobOutput>;
  grep: Tool<GrepInput, GrepOutput>;
  "read-file": Tool<ReadFileInput, ReadFileOutput>;
  "write-file": Tool<WriteFileInput, WriteFileOutput>;
  "web-fetch": Tool<WebFetchInput, WebFetchOutput>;
  "load-skill": Tool<LoadSkillInput, LoadSkillOutput>;
  "job-output": Tool<JobOutputInput, JobOutputOutput>;
  "job-list": Tool<JobListInput, JobListOutput>;
  "job-kill": Tool<JobKillInput, JobKillOutput>;
  questionnaire: Tool<QuestionnaireToolInput, QuestionnaireToolOutput>;
  bash: Tool<ShellToolInput, ShellToolOutput>;
  powershell: Tool<ShellToolInput, ShellToolOutput>;
  task: Tool<TaskToolInput, TaskToolOutput>;
  "search-tools": Tool<SearchToolsInput, ToolOutput<SearchToolsOutput>>;
  "call-tool": Tool<CallToolInput, ToolOutput>;
};
