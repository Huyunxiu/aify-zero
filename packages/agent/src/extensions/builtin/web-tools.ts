import { createWebFetchTool } from "../../tools/web-fetch";
import type { ExtensionAPI, ExtensionOptions } from "../types";
import { Extension } from "../types";

const DEFAULT_OPTIONS: ExtensionOptions = { id: "web-tools" };

/** 网络读取扩展。 */
export class WebToolsExtension extends Extension {
  constructor(options: ExtensionOptions = DEFAULT_OPTIONS) {
    super(options);
  }

  init(api: ExtensionAPI): void {
    api.tool(
      "web-fetch",
      createWebFetchTool({ agentContext: api.environment })
    );
  }
}
