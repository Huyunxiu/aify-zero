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
