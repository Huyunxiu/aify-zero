import type { AgentContext } from "../agent-context";
import { MAX_OUTPUT_BYTES, MAX_OUTPUT_LINES } from "./shell/output";
import { bashArgv, defaultBashShell } from "./shell/resolve";
import { createShellTool } from "./shell/tool";

/**
 * 传给 Bash 子进程的环境变量覆盖（这个常量名不是 Bash 的 `BASH_ENV` 环境变量）。
 * 这些设置可减少颜色、分页器和终端控制字符对捕获输出的干扰。
 */
const BASH_ENV: NodeJS.ProcessEnv = {
  // 让 Git 直接输出，不启动 less 等分页器。
  GIT_PAGER: "cat",
  // 请求支持 NO_COLOR 约定的程序关闭彩色输出。
  NO_COLOR: "1",
  // 让其他使用通用分页器设置的命令也直接输出。
  PAGER: "cat",
  // 声明终端功能有限，避免程序依赖复杂的终端控制能力。
  TERM: "dumb",
};

const DESCRIPTION = `Execute a bash command (\`bash -c\`) in the working directory.
- Each call runs in a fresh shell; pass \`workdir\` instead of using \`cd\` commands.
- Output is truncated to its tail (${MAX_OUTPUT_LINES} lines or ${MAX_OUTPUT_BYTES / 1024} KB per stream, whichever comes first). When truncated, the full output is saved to a file whose path is reported.
- A non-zero exit is reported as \`[exit code: N]\`; a terminated command as \`[killed by signal: X]\` or \`[timed out after Nms]\`. Investigate failures before continuing.
- Commands that run longer than the timeout are terminated (default: 2 minutes).
- Before any delete or move, verify that the resolved absolute target path is the intended one; never run it against a computed path you have not checked.`;

export const createBashTool = ({
  agentContext,
}: {
  agentContext: AgentContext;
}) =>
  createShellTool({
    description: DESCRIPTION,
    agentContext,
    program: () => {
      const file = defaultBashShell();
      if (file === undefined) {
        throw new Error(
          "No bash executable found. Install Git Bash (Windows) or bash (POSIX), or use the powershell tool."
        );
      }
      return {
        argv: (command) => bashArgv(file, command),
        env: BASH_ENV,
      };
    },
  });

export type BashToolType = ReturnType<typeof createBashTool>;
