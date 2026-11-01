import { SUBAGENT_DEFINITIONS } from "../../subagent/definitions";
import type { SubagentDefinition } from "../../subagent/definitions";
import { createTaskTool } from "../../tools/task";
import { Capabilities } from "../capabilities";
import type { ExtensionAPI, ExtensionOptions } from "../types";
import { Extension } from "../types";

export interface SubagentExtensionOptions extends ExtensionOptions {
  /** 可用的子 agent；默认 {@link SUBAGENT_DEFINITIONS}。 */
  definitions?: readonly SubagentDefinition[];
}

const DEFAULT_OPTIONS: SubagentExtensionOptions = { id: "subagent" };

/**
 * 子 agent 扩展：注册 `task` 工具。
 *
 * 工具的依赖全部来自 capability：transcript 用来找到自己的调用，subagents
 * 用来创建和等待子会话。它不 import `Agent`。
 */
export class SubagentExtension extends Extension {
  readonly #definitions: readonly SubagentDefinition[];

  constructor(options: SubagentExtensionOptions = DEFAULT_OPTIONS) {
    super(options);
    this.#definitions = options.definitions ?? SUBAGENT_DEFINITIONS;
  }

  init(api: ExtensionAPI): void {
    api.tool(
      "task",
      createTaskTool({
        transcript: api.use(Capabilities.transcript),
        subagents: api.use(Capabilities.subagents),
        definitions: this.#definitions,
      })
    );
  }
}
