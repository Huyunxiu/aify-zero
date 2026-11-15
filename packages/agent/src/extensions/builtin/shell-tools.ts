import { createBashTool } from "../../tools/bash";
import { createPowerShellTool } from "../../tools/powershell";
import type { ExtensionAPI, ExtensionOptions } from "../types";
import { Extension } from "../types";

const DEFAULT_OPTIONS: ExtensionOptions = { id: "shell-tools" };

/**
 * Shell 工具扩展。
 *
 * 只注册沙箱声称能跑的方言：一个跑不了的程序不应该先给模型看见、再在调用时
 * 失败。本机适配器按真的能解析到的可执行文件声明，所以 Windows 上装了 Git
 * Bash 时 bash 和 powershell 都在。
 */
export class ShellToolsExtension extends Extension {
  constructor(options: ExtensionOptions = DEFAULT_OPTIONS) {
    super(options);
  }

  init(api: ExtensionAPI): void {
    const { shells } = api.environment.sandbox.describe();

    if (shells.includes("bash")) {
      api.tool("bash", createBashTool({ agentContext: api.environment }));
    }

    if (shells.includes("powershell")) {
      api.tool(
        "powershell",
        createPowerShellTool({ agentContext: api.environment })
      );
    }
  }
}
