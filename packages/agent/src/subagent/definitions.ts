import type { ModelRef } from "@workspace/shared/model";
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
   * `task` and `questionnaire` are removed either way, so a subagent can never
   * delegate again and has no user to ask.
   */
  tools?: readonly string[];
  /** A model to run this subagent on, when it should differ from the parent's. */
  model?: ModelRef;
};

/**
 * The tools a read-only subagent runs with.
 *
 * The exploration and planning subagents must not change the tree, and a
 * prompt-only prohibition does not stop a tool call. Bash is out for the same
 * reason: it can write. A subagent that needs history from a command is the
 * general one.
 */
const READ_ONLY_TOOLS = ["read-file", "glob", "grep", "load-skill"] as const;

const SUBAGENT_PREAMBLE = `You are a subagent launched by a parent agent to carry out one self-contained task.

- Work autonomously. The user cannot see your questions and will not answer them.
- You cannot delegate to other agents: there is no task tool here.
- Use the tools you have to find out what you need rather than asking.
- Your last message must be the text report itself. A turn that ends on a tool call leaves the parent with no report.
- Finish with a concise report of what you found or did, written for the parent agent. State what you did not do as clearly as what you did.`;

export const SUBAGENT_DEFINITIONS: readonly SubagentDefinition[] = [
  {
    name: "general",
    description:
      "General-purpose agent for a multi-step task: searching, reading, and carrying it through to a result.",
    instructions: `${SUBAGENT_PREAMBLE}

You are the general-purpose subagent. You have the full tool set, so you can change files as well as read them. Carry the task out; do not stop at a plan.`,
  },
  {
    name: "explore",
    description:
      "Read-heavy agent for finding code: which files hold a symbol, how a flow is wired, what a module exports.",
    instructions: `${SUBAGENT_PREAMBLE}

You are the exploration subagent. Answer one question: where is this, and how does it work. Back the answer with the paths and line numbers you read, and quote the smallest useful excerpts rather than whole files.`,
    tools: READ_ONLY_TOOLS,
  },
  {
    name: "plan",
    description:
      "Planning agent for working out how a change should be made before anything is edited.",
    instructions: `${SUBAGENT_PREAMBLE}

You are the planning subagent. Read enough of the codebase to be concrete, then propose a plan: the files to touch, the order to do it in, and the trade-offs you rejected. Do not edit files — the parent decides what to carry out.`,
    tools: READ_ONLY_TOOLS,
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
 * rule for using it travel together. The rule about what a subagent cannot do
 * belongs here, where the parent reads it; the subagent's own copy lives in its
 * preamble, where the subagent reads it.
 */
export function renderSubagentCatalogue(prompt: string): string {
  const catalogue = [
    "",
    "## Available Subagents",
    "Use the `task` tool to delegate a self-contained piece of work — one that would otherwise fill this conversation with searching or reading. Give it the whole task, not a single step, and write the brief so it stands alone: a subagent cannot ask the user anything.",
    "Start independent delegations in the same message; they then run at the same time. Do not delegate the same work twice.",
    ...SUBAGENT_DEFINITIONS.map(
      (definition) => `- **${definition.name}**: ${definition.description}`
    ),
  ].join("\n");

  return prompt + catalogue;
}
