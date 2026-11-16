import type { CallToolToolType } from "./tools/call-tool";
import type {
  BashToolType,
  DeleteFileToolType,
  EditFileToolType,
  GlobToolType,
  GrepToolType,
  JobKillToolType,
  JobListToolType,
  JobOutputToolType,
  PowerShellToolType,
  QuestionnaireToolType,
  ReadFileToolType,
  TaskToolType,
  WebFetchToolType,
  WriteFileToolType,
} from "./tools/index";
import type { LoadSkillToolType } from "./tools/load-skill";
import type { SearchToolsToolType } from "./tools/search-tools";

export type AgentToolSet = {
  "delete-file": DeleteFileToolType;
  "edit-file": EditFileToolType;
  grep: GrepToolType;
  glob: GlobToolType;
  "read-file": ReadFileToolType;
  "write-file": WriteFileToolType;
  "web-fetch": WebFetchToolType;
  "load-skill": LoadSkillToolType;
  "job-output": JobOutputToolType;
  "job-list": JobListToolType;
  "job-kill": JobKillToolType;
  questionnaire: QuestionnaireToolType;
  bash: BashToolType;
  powershell: PowerShellToolType;
  task: TaskToolType;
  "search-tools": SearchToolsToolType;
  "call-tool": CallToolToolType;
};

/**
 * 一个工具怎么让模型看见。
 *
 * `direct` 随每一步请求一起声明给模型；`deferred` 不给模型，只进工具目录，
 * 模型搜到之后靠转调去调它。
 */
export type ToolExposure = "direct" | "deferred";
