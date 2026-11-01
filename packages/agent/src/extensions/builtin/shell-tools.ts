import { createBashTool } from "../../tools/bash";
import { createPowerShellTool } from "../../tools/powershell";
import { defaultBashShell, defaultPowerShell } from "../../tools/shell/resolve";
import type { ExtensionAPI, ExtensionOptions } from "../types";
import { Extension } from "../types";

const DEFAULT_OPTIONS: ExtensionOptions = { id: "shell-tools" };

/**
 * Shell 工具扩展。
 *
 * 只注册宿主上真的能解析到的可执行文件：一个解析不到的程序不应该先给模型
 * 看见、再在调用时失败。Windows 上 Git Bash 存在时 bash 和 powershell 都在。
 */
export class ShellToolsExtension extends Extension {
  constructor(options: ExtensionOptions = DEFAULT_OPTIONS) {
    super(options);
  }

  init(api: ExtensionAPI): void {
    if (defaultBashShell() !== undefined) {
      api.tool("bash", createBashTool({ agentContext: api.environment }));
    }

    if (defaultPowerShell() !== undefined) {
      api.tool(
        "powershell",
        createPowerShellTool({ agentContext: api.environment })
      );
    }
  }
}
