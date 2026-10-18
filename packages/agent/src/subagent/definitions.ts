/**
 * The subagents a `task` call can delegate to.
 *
 * They are constants rather than rows: what a subagent is — its prompt and the
 * tools it may use — is part of the runtime, and the model is offered the list
 * through the system prompt. Nothing here is user-editable yet.
 */
export type SubagentDefinition = {
  /** The name the model passes as `subagent_type`. */
  name: string;
  /** One line for the system prompt, saying when to reach for this one. */
  description: string;
  /** The subagent's own instructions, appended to the runtime preamble. */
  instructions: string;
  /**
   * The tools this subagent may use, by tool name. Absent means every tool —
   * `task` is removed either way, so a subagent can never delegate again.
   */
  tools?: readonly string[];
  /** A model to run this subagent on, when it should differ from the parent's. */
  modelId?: string;
};

const SUBAGENT_PREAMBLE = `You are a subagent launched by a parent agent to carry out one self-contained task.

- Work autonomously. The user cannot see your questions and will not answer them.
- You cannot delegate to other agents: there is no task tool here.
- Use the tools you have to find out what you need rather than asking.
- Finish with a concise report of what you found or did, written for the parent agent. State what you did not do as clearly as what you did.`;

export const SUBAGENT_DEFINITIONS: readonly SubagentDefinition[] = [
  {
    name: "general",
    description:
      "General-purpose agent for a multi-step task: searching, reading, and carrying it through to a result.",
    instructions: `${SUBAGENT_PREAMBLE}

You are the general-purpose subagent. You have the full tool set, so you can change files as well as read them. Prefer finishing the task over reporting that it could be finished.`,
  },
  {
    name: "explore",
    description:
      "Read-heavy agent for finding code: which files hold a symbol, how a flow is wired, what a module exports.",
    instructions: `${SUBAGENT_PREAMBLE}

You are the exploration subagent. Your value is a precise answer to "where is this and how does it work", backed by the paths and line numbers you actually read. Quote the smallest useful excerpts rather than whole files.`,
  },
  {
    name: "plan",
    description:
      "Planning agent for working out how a change should be made before anything is edited.",
    instructions: `${SUBAGENT_PREAMBLE}

You are the planning subagent. Read enough of the codebase to be concrete, then propose a plan: the files to touch, the order to do it in, and the trade-offs you rejected. Do not edit files — the parent decides what to carry out.`,
  },
];

/** The subagent a call falls back to when it names one that does not exist. */
export const DEFAULT_SUBAGENT_NAME = "general";

export function getSubagentDefinition(
  name: string | undefined
): SubagentDefinition | undefined {
  return SUBAGENT_DEFINITIONS.find((definition) => definition.name === name);
}

/**
 * The subagent catalogue, appended to the parent's system prompt.
 *
 * The model only delegates if it knows the choice exists, so the list and the
 * rule for using it travel together with the skill list the runtime already
 * appends.
 */
export function appendSubagentPrompt(prompt: string): string {
  const catalogue = [
    "",
    "## Available Subagents",
    "Use the `task` tool to delegate a self-contained piece of work — one that would otherwise fill this conversation with searching or reading — and give it the whole task, not a single step. Subagents cannot ask the user anything, so the prompt must stand on its own.",
    ...SUBAGENT_DEFINITIONS.map(
      (definition) => `- **${definition.name}**: ${definition.description}`
    ),
  ].join("\n");

  return prompt + catalogue;
}
