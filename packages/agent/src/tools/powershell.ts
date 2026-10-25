import type { AgentContext } from "../agent-context";
import { MAX_OUTPUT_BYTES, MAX_OUTPUT_LINES } from "./shell/output";
import { defaultPowerShell, powerShellArgv } from "./shell/resolve";
import { createShellTool } from "./shell/tool";

/**
 * 传给 PowerShell 子进程的环境变量覆盖，用于让命令输出更适合捕获和阅读。
 * `TERM=dumb` 是 POSIX 终端约定，因此这里不设置；现代 pwsh 渲染器会遵循
 * `NO_COLOR` 约定关闭颜色。
 */
const POWERSHELL_ENV: NodeJS.ProcessEnv = {
  // 让 Git 直接输出，不启动 less 等分页器。
  GIT_PAGER: "cat",
  // 请求支持 NO_COLOR 约定的程序（包括现代 pwsh 渲染器）关闭彩色输出。
  NO_COLOR: "1",
  // 让其他使用通用分页器设置的命令也直接输出。
  PAGER: "cat",
};

const DESCRIPTION = `Execute a PowerShell command (\`pwsh -Command\`) in the working directory.
- Each call runs in a fresh, non-interactive process; pass \`workdir\` instead of using \`cd\` commands.
- Paths use native Windows form (\`C:\\...\`); read environment variables with \`$env:NAME\`.
- Output is truncated to its tail (${MAX_OUTPUT_LINES} lines or ${MAX_OUTPUT_BYTES / 1024} KB per stream, whichever comes first). When truncated, the full output is saved to a file whose path is reported.
- UTF-8 output is pinned, so non-ASCII output is not garbled.
- A non-zero exit is reported as \`[exit code: N]\`; a terminated command as \`[killed by signal: X]\` or \`[timed out after Nms]\`.
- Commands that run longer than the timeout are terminated (default: 2 minutes).
- Before any delete or move, verify that the resolved absolute target path is the intended one; never run it against a computed path you have not checked.`;

export const createPowerShellTool = ({
  agentContext,
}: {
  agentContext: AgentContext;
}) =>
  createShellTool({
    description: DESCRIPTION,
    agentContext,
    kind: "powershell",
    program: () => {
      const file = defaultPowerShell();
      if (file === undefined) {
        throw new Error(
          "No PowerShell executable found. Install PowerShell 7 (pwsh) or use the bash tool."
        );
      }
      return {
        argv: (command) => powerShellArgv(file, command),
        env: POWERSHELL_ENV,
      };
    },
  });

export type PowerShellToolType = ReturnType<typeof createPowerShellTool>;
