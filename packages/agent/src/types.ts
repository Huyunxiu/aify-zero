import type {
  BashToolType,
  DeleteFileToolType,
  EditFileToolType,
  GlobToolType,
  GrepToolType,
  QuestionnaireToolType,
  ReadFileToolType,
  TaskToolType,
  WebFetchToolType,
  WriteFileToolType,
} from "@workspace/agent/tools/index";
import type { LoadSkillToolType } from "@workspace/agent/tools/load-skill";

export type AgentToolSet = {
  "delete-file": DeleteFileToolType;
  "edit-file": EditFileToolType;
  grep: GrepToolType;
  glob: GlobToolType;
  "read-file": ReadFileToolType;
  "write-file": WriteFileToolType;
  "web-fetch": WebFetchToolType;
  "load-skill": LoadSkillToolType;
  questionnaire: QuestionnaireToolType;
  bash: BashToolType;
  task: TaskToolType;
};
