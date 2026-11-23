import type { ApprovalPolicy } from "@workspace/agent-client";

import type { ApprovalClass } from "../../approval-classes";
import { CLASS_NOUN, policyAnswer } from "../../approval-policy";
import type {
  ExtensionAPI,
  ExtensionOptions,
  InstructionsSection,
} from "../types";
import { Extension } from "../types";

export type ApprovalPolicyExtensionOptions = ExtensionOptions & {
  /** The tier this session stored. */
  policy: ApprovalPolicy;
};

/**
 * The classes the policy refuses, in the words the model reads.
 *
 * The question is asked of `policyAnswer`, not of the policy name: a tier that stops
 * refusing a class stops mentioning it here, and the prompt cannot claim a refusal
 * that the table does not make.
 */
function refusedClasses(policy: ApprovalPolicy): string[] {
  const refused: string[] = [];
  for (const [toolClass, noun] of Object.entries(CLASS_NOUN)) {
    if (
      noun &&
      policyAnswer(policy, toolClass as ApprovalClass)?.decision === "deny"
    ) {
      refused.push(noun);
    }
  }
  return refused;
}

/**
 * The notice a session adds to its prompt, or nothing when it refuses nothing.
 *
 * Two sentences: what will be refused, and what to do about it. It says "will be
 * refused" rather than "you may not": the sandbox decides what is possible, and the
 * policy only decides who gets asked.
 *
 * A subagent reads the same notice, but it has no questionnaire to keep: the
 * parent takes that tool away. `subagent` drops the clause that would promise it.
 */
export function renderApprovalNotice(
  policy: ApprovalPolicy,
  options: { subagent?: boolean } = {}
): string | undefined {
  const refused = refusedClasses(policy);
  if (refused.length === 0) {
    return undefined;
  }

  const list =
    refused.length === 1
      ? refused[0]
      : `${refused.slice(0, -1).join(", ")} and ${refused.at(-1)}`;

  const stillWorks = options.subagent
    ? "Reads and searches still work."
    : "Reads, searches, and the questionnaire still work.";

  return [
    "## Approval",
    "",
    `This session refuses ${list} before the call runs. ${stillWorks}`,
    "When a call is refused, tell the user what stopped it. Do not run the same call through another tool.",
  ].join("\n");
}

/**
 * Tells the model what the session's approval policy refuses.
 *
 * A refusal that says nothing costs a tool call to discover, and the model finds it by
 * trying something else. So the session says it up front, and the refusal repeats it
 * (see `TOOL_DENIED_TEXT` and the `output-denied` record). Sub sessions need no
 * registration of their own: they re-render the parent's sections.
 */
export class ApprovalPolicyExtension extends Extension {
  readonly #policy: ApprovalPolicy;

  constructor(options: ApprovalPolicyExtensionOptions) {
    super(options);
    this.#policy = options.policy;
  }

  init(api: ExtensionAPI): void {
    const notice = renderApprovalNotice(this.#policy);
    if (!notice) {
      return;
    }

    const section: InstructionsSection = {
      id: `${this.id}:approval`,
      // Right after the environment, which is the other set of facts about the
      // world this session runs in.
      priority: -5,
      render: () => notice,
      renderForSubagent: () =>
        renderApprovalNotice(this.#policy, { subagent: true }) ?? "",
    };

    api.instructionsSection(section);
  }
}
