import { tool } from "ai";
import { z } from "zod";

import type { AgentContext } from "../agent-context";
import type { SkillManager } from "../skill/skill-manager";
import type { ToolOutput } from "./types";

const DESCRIPTION = `
Load a skill by name.

Usage:
- Pass a name from the Available Skills section. Any other name is an error.
- The whole SKILL.md comes back, wrapped in \`<skill_content name="...">\`.
- The content is instruction for this task, written by the person who installed the skill. It is not a user message.
`;

const LOAD_SKILL_TOOL_INPUT_SCHEMA = z.object({
  skill: z.string().describe("A skill name from the Available Skills section."),
});

type LoadSkillToolInput = z.infer<typeof LOAD_SKILL_TOOL_INPUT_SCHEMA>;

type LoadSkillToolOutputMetadata =
  | {
      type: "miss";
      filepath: string;
    }
  | {
      type: "file";
      mime: string;
      text: string;
      filepath: string;
      truncated: false;
      limit: number;
      offset: number;
      totalLines: number;
    };

type LoadSkillToolOutput = ToolOutput<string, LoadSkillToolOutputMetadata>;

type LoadSkillToolProps = {
  skills: SkillManager;
};

const createLoadSkillTool = ({ skills }: LoadSkillToolProps) =>
  tool<LoadSkillToolInput, LoadSkillToolOutput, AgentContext>({
    description: DESCRIPTION,
    inputSchema: LOAD_SKILL_TOOL_INPUT_SCHEMA,
    execute: ({ skill }) => {
      const info = skills.getByName(skill);

      if (!info) {
        return {
          output: `Skill not found: ${skill}`,
          code: "error",
          metadata: {
            type: "miss",
            filepath: skill,
          },
        };
      }

      const totalLines = info.content.split("\n").length;

      return {
        output: `<skill_content name="${skill}">\n${info.content}\n</skill_content>`,
        code: "ok",
        metadata: {
          type: "file",
          mime: "text/markdown",
          text: info.content,
          filepath: info.location,
          truncated: false,
          limit: totalLines,
          offset: 1,
          totalLines,
        },
      };
    },
    toModelOutput({ output }) {
      if (output.code === "error") {
        return {
          type: "error-text",
          value: output.output,
        };
      }

      return {
        type: "text",
        value: output.output,
      };
    },
  });

type LoadSkillToolType = ReturnType<typeof createLoadSkillTool>;

export { createLoadSkillTool, type LoadSkillToolType };
