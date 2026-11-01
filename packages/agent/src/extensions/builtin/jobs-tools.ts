import { createJobTools } from "../../tools/jobs";
import type { ExtensionAPI, ExtensionOptions } from "../types";
import { Extension } from "../types";

const DEFAULT_OPTIONS: ExtensionOptions = { id: "jobs-tools" };

/**
 * 后台任务控制扩展。
 *
 * 没有任务注册表就没有可控制的任务，所以这三个工具一起缺席，而不是注册成
 * 一个永远失败的工具。
 */
export class JobsToolsExtension extends Extension {
  constructor(options: ExtensionOptions = DEFAULT_OPTIONS) {
    super(options);
  }

  init(api: ExtensionAPI): void {
    if (api.environment.jobs === undefined) {
      return;
    }

    const tools = createJobTools({ agentContext: api.environment });
    for (const [name, tool] of Object.entries(tools)) {
      api.tool(name, tool);
    }
  }
}
