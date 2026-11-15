import { join } from "node:path";

import {
  bashArgv,
  defaultBashShell,
  defaultPowerShell,
  powerShellArgv,
} from "./resolve";

/**
 * 一条命令实际交给哪个程序。
 *
 * `cmd` 只在 Windows 且没有 bash 时出现：它不面朝模型（没有对应工具），只是
 * `exec` 省略方言时的兜底，让 `grep`、`glob` 这类内部命令仍能跑。
 */
export type ShellProgram = "bash" | "powershell" | "cmd";

/** `sandbox-exec`、`bwrap` 和工具看到的 argv 都从这里取，只在这一处拼。 */
export interface ShellInvocation {
  readonly file: string;
  readonly args: readonly string[];
}

/**
 * 省略 `shell` 时的默认方言：能解析到 bash 就用 bash，否则 Windows 退回 `cmd`。
 *
 * 与引入沙箱之前一致：那两个搜索工具用的是 `spawn({ shell: true })`，Windows
 * 上就是 `cmd.exe`。
 */
export function defaultShellProgram(): ShellProgram {
  if (defaultBashShell() !== undefined) {
    return "bash";
  }
  return process.platform === "win32" ? "cmd" : "bash";
}

/** Windows 的 `cmd.exe`，走系统目录绝对路径，不依赖 PATH。 */
function cmdExecutable(): string {
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  return join(systemRoot, "System32", "cmd.exe");
}

/**
 * 把命令渲染成 argv。
 *
 * 解析不到方言时抛出与工具一致的错：调用方拿到的应该是「这台机器没有 bash」，
 * 而不是一条神秘的空 argv。
 */
export function shellProgramArgv(
  program: ShellProgram,
  command: string
): ShellInvocation {
  const [file, ...args] = argvFor(program, command);
  if (file === undefined) {
    throw new Error("The shell program resolved to an empty argv.");
  }
  return { file, args };
}

function argvFor(program: ShellProgram, command: string): string[] {
  if (program === "bash") {
    const executable = defaultBashShell();
    if (executable === undefined) {
      throw new Error(
        "No bash executable found. Install Git Bash (Windows) or bash (POSIX)."
      );
    }
    return bashArgv(executable, command);
  }

  if (program === "powershell") {
    const executable = defaultPowerShell();
    if (executable === undefined) {
      throw new Error("No PowerShell executable found.");
    }
    return powerShellArgv(executable, command);
  }

  // `/d` 跳过 AutoRun，`/s` 保留引号语义，`/c` 执行命令：与 Node 的
  // `spawn({ shell: true })` 在 Windows 上的行为一致。
  return [cmdExecutable(), "/d", "/s", "/c", command];
}
