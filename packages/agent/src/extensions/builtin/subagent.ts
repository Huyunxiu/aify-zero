import {
  renderSubagentCatalogue,
  SUBAGENT_DEFINITIONS,
} from "../../subagent/definitions";
import type { SubagentDefinition } from "../../subagent/definitions";
import { createCreateSubagentTool } from "../../tools/create-subagent";
import { createListAgentsTool } from "../../tools/list-agents";
import { createSendMessageTool } from "../../tools/send-message";
import { createStopAgentTool } from "../../tools/stop-agent";
import { Capabilities } from "../capabilities";
import type { ExtensionAPI, ExtensionOptions } from "../types";
import { Extension } from "../types";

export interface SubagentExtensionOptions extends ExtensionOptions {
  /** 可用的子 agent；默认 {@link SUBAGENT_DEFINITIONS}。 */
  definitions?: readonly SubagentDefinition[];
}

const DEFAULT_OPTIONS: SubagentExtensionOptions = { id: "subagent" };

/**
 * The subagent extension: it registers the four delegation tools.
 *
 * Every dependency comes through a capability: `subagents` derives, lists, hands
 * a message to, and stops a subagent. The tools do not import `Agent`.
 */
export class SubagentExtension extends Extension {
  readonly #definitions: readonly SubagentDefinition[];

  constructor(options: SubagentExtensionOptions = DEFAULT_OPTIONS) {
    super(options);
    this.#definitions = options.definitions ?? SUBAGENT_DEFINITIONS;
  }

  init(api: ExtensionAPI): void {
    const subagents = api.use(Capabilities.subagents);

    api.tool(
      "create-subagent",
      createCreateSubagentTool({
        subagents,
        definitions: this.#definitions,
      })
    );
    api.tool("list-agents", createListAgentsTool({ subagents }));
    api.tool("send-message", createSendMessageTool({ subagents }));
    api.tool("stop-agent", createStopAgentTool({ subagents }));

    api.instructionsSection({
      id: `${this.id}:catalogue`,
      // After the facts and the resource lists: the model picks a subagent once
      // it knows where it is and what it has.
      priority: 90,
      render: renderSubagentCatalogue,
      // A subagent has no task tool, so the catalogue tells it nothing it can do.
      renderForSubagent: () => "",
    });
  }
}
