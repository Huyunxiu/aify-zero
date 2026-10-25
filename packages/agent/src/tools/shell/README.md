# Shell 工具内核（bash / powershell）

`bash` 与 `powershell` 两个模型工具共用的执行内核。上层薄配置在 [`bash.ts`](../bash.ts) 和 [`powershell.ts`](../powershell.ts)；本目录负责可执行文件解析、进程生命周期、输出收集和模型结果渲染。每次调用都是全新进程，不保留 cwd、变量或函数。

## 模块地图

| 文件                       | 职责                                               | 副作用               |
| -------------------------- | -------------------------------------------------- | -------------------- |
| [resolve.ts](./resolve.ts) | 解析 shell 可执行文件、构造 argv、探测安装位置     | 否（`lstat` 只读）   |
| [exec.ts](./exec.ts)       | spawn、超时/取消、TERM→KILL、exit 后排空、结果分类 | 是（启动并终止进程） |
| [output.ts](./output.ts)   | 尾部保留、按字节/行截断、完整输出落盘、UTF-8 解码  | 是（写 spill 文件）  |
| [tool.ts](./tool.ts)       | zod schema、cwd 校验、`ToolOutput` 与模型可见结果  | 否（编排前两者）     |

调用方只需要 `createShellTool()`；`resolve` / `exec` / `output` 都可以单独测试或复用。

## 一次调用的数据流

```text
tool.execute(input)
  ├─ resolveToolPath(workdir ?? primaryProjectDir) + stat(cwd)
  ├─ program() → { argv, env }          // 由 bash.ts / powershell.ts 提供
  ├─ runShell(...)                       // exec.ts
  │    spawn(file, args)
  │      ├─ stdout/stderr data → onData(channel, chunk)
  │      │                        └─ collector.push()   // output.ts
  │      └─ exit + 空闲排空 → { exitCode, signal, timedOut, aborted, durationMs }
  ├─ collector.finish() → { stdout, stderr, truncated, spillPath?, … }
  └─ ToolOutput { output, code: "ok", metadata }
       └─ toModelOutput() → 正文 + 状态 marker
```

## resolve.ts

### 解析顺序

| 平台                  | 候选（按顺序）                                                                                                                                | 兜底                   |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| POSIX bash            | `/bin/bash` → `/usr/bin/bash` → `/usr/local/bin/bash` → `/bin/sh`                                                                             | 裸 `bash`（PATH 查找） |
| Windows bash          | `%ProgramFiles%\Git\bin\bash.exe` → `%ProgramFiles(x86)%\…` → `%LOCALAPPDATA%\Programs\Git\bin\bash.exe` → PATH 各项                          | 无（返回 `undefined`） |
| Windows PowerShell    | `PWSH_PATH` → `%ProgramFiles%\PowerShell\7\pwsh.exe` → PATH 各项的 `pwsh.exe` → `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe` | 无（返回 `undefined`） |
| 非 Windows PowerShell | —                                                                                                                                             | 无（返回 `undefined`） |

- PATH 条目会去掉首尾引号并跳过空项；Windows 路径统一用 `win32.join` 构造，因此这套解析可以跨平台单测。
- 用 `lstat` 而不是 `stat`：Microsoft Store 的 `pwsh.exe` 是执行别名，`stat` 会撞到目标 ACL，`lstat` 能看到符号链接本身；真实目录不算候选。
- 旧版 WSL 的 `System32\bash.exe` 故意不支持：它要 `-s` + stdin 传命令，argv 语义不同。
- `bashArgv` / `powerShellArgv` 返回**完整 argv**（可执行文件在第一位）。PowerShell 的命令是单个 `-Command` 参数，前面拼 UTF-8 固定语句，避免 PowerShell 5.1 按 OEM 代码页输出乱码。
- `resolveBashShell` / `resolvePowerShell` 是纯函数（`env`、`platform`、`exists` 可注入）；`defaultBashShell` / `defaultPowerShell` 是进程级记忆化版本，供会话装配调用。

## exec.ts

```ts
runShell(options: ShellRunOptions): Promise<ShellRunResult>
```

| 输入/输出         | 字段                                                                                               |
| ----------------- | -------------------------------------------------------------------------------------------------- |
| `ShellRunOptions` | `file`、`args`、`cwd`、`env`、`timeoutMs`、`signal`、`onData`、`onSpawn`、`graceMs`、`drainIdleMs` |
| `ShellRunResult`  | `exitCode`、`signal`、`timedOut`、`aborted`、`durationMs`                                          |

**生命周期**

1. 预取消（`signal.aborted`）直接返回 `aborted: true`，不 spawn。
2. POSIX 用 `detached: true` 建独立进程组；Windows 关闭 `detached` 并 `windowsHide`。stdio 固定为 `ignore / pipe / pipe`。
3. 超时和调用方取消共用一个「第一因」标记：谁先触发就记谁，另一个不再生效。
4. POSIX 先给进程组发 `SIGTERM`，`graceMs`（默认 2s）后仍未退出则 `SIGKILL`；Windows 直接 `taskkill /PID <pid> /T /F`（走 `System32` 绝对路径，不依赖 PATH）。
5. **settle 条件不是 `close`**：监听 `exit`，之后每次 stdout/stderr 的 `data` / `close` 都重置一个 100ms 空闲计时器；空闲后销毁管道并返回。这样孙进程握着管道时既不会挂死，也不会丢掉它退出前写出的内容。
6. 超时计时器一直武装到 settle（包括排空阶段），因此持续输出的后台孙进程无法把调用无限延长。
7. settle 或 spawn 失败时清理所有计时器与监听；`SIGKILL` 定时器不会在进程退出后残留（避免误杀被复用的 PID）。

**错误语义**

- `spawn` 失败（可执行文件或 cwd 不存在、权限不足）→ Promise reject；工具层转成工具错误。
- 非零退出、超时、取消 → 正常 resolve，由结果字段表达。
- 进程退出码为 `null` 表示被信号终止，`signal` 携带信号名。

## output.ts

| 限额               | 值   | 说明                                     |
| ------------------ | ---- | ---------------------------------------- |
| `MAX_OUTPUT_BYTES` | 50KB | 每条流保留的尾部字节数                   |
| `MAX_OUTPUT_LINES` | 2000 | 每条流保留的尾部行数（与字节数先到先算） |
| `MAX_SPILL_BYTES`  | 64MB | spill 文件上限；超过后只保留已写部分     |
| 滚动缓冲           | 2×   | 每流先留 100KB，供最终按行截断使用       |

- 每条流一个流式 `TextDecoder`，chunk 切断多字节字符也不会产生乱码。
- 未超限时原样返回；超限时用 [`truncateContent`](../../utils/truncate.ts) 取尾部，并保留原输出的结尾换行。
- 单行超过 50KB 时没有完整行可留，退化为保留最后 50KB 字节（仍按 UTF-8 边界切）。
- 超限后把**从开头起**的原始字节写入 `<sessionDir>/shell/<tool_id>.txt`（`createToolId()` 命名）；spill 写失败只降级为“没有路径”，不影响命令结果。
- `finish()` 幂等：错误路径也能安全调用它关闭 spill 文件。

`ShellOutputSnapshot`：

| 字段             | 含义                                           |
| ---------------- | ---------------------------------------------- |
| `stdout`         | 保留的 stdout 尾部                             |
| `stderr`         | 保留的 stderr 尾部                             |
| `truncated`      | 任一流是否超限                                 |
| `spillPath`      | 完整输出（或 spill 上限内的部分）路径          |
| `spillTruncated` | spill 文件是否触到 64MB 上限                   |
| `spillFailed`    | spill 是否完全写不出去（此时正文只有截断提示） |

## tool.ts

```ts
createShellTool({ description, agentContext, program }): Tool<ShellToolInput, ShellToolOutput, AgentContext>
```

| 入参          | 说明                                            |
| ------------- | ----------------------------------------------- |
| `command`     | 非空命令文本，作为单个 argv 元素传给 shell      |
| `timeout`     | 毫秒，正数，默认 `DEFAULT_TIMEOUT_MS`（2 分钟） |
| `workdir`     | 相对路径按项目主目录解析；默认项目主目录        |
| `description` | 5–10 词的 UI 标签，非空                         |

执行前用 `stat` 检查工作目录；不存在时报 `Working directory does not exist: <path>`，不会 spawn。

**正文**（`ToolOutput.output`，模型和 UI 都能看到）：

```text
<stdout>
[stderr]
<stderr>

[output truncated; full output: <path>]
```

stdout 为空且无 stderr 时正文是 `(no output)`；截断提示追加在最后（失败原因通常在尾部）。

**模型可见的状态 marker**（只在 `toModelOutput` 追加，UI 用 metadata 显示摘要）：

| marker                      | 触发条件               |
| --------------------------- | ---------------------- |
| `[timed out after <N>ms]`   | 执行器自身超时         |
| `[aborted]`                 | 调用方取消             |
| `[killed by signal: <SIG>]` | 进程被信号终止         |
| `[exit code: <N>]`          | 非零退出且没有信号终止 |

**metadata**：`exitCode`、`signal`、`timeout`、`aborted`、`timeoutMs`、`durationMs`、`truncated`、`spillPath?`。UI 的 [`tool-step.tsx`](../../../../ui/src/elements/tool-step.tsx) 用这些字段生成 `exit N` / `timed out` / `killed by SIG` / `output truncated` 摘要。

`code` 始终是 `"ok"`：非零退出、超时、取消都是命令结果，不是工具失败；只有这样 UI 才不会把整行标红。只有基础设施错误（spawn 失败、cwd 不存在）才抛异常。

## 组合方式

- [`bash.ts`](../bash.ts)：`bashArgv` + `NO_COLOR/TERM=dumb/PAGER` 等终端覆盖。
- [`powershell.ts`](../powershell.ts)：`powerShellArgv` + 不含 `TERM` 的覆盖。
- [`session.ts`](../../../../server/src/routers/session.ts)：POSIX 始终注册 `bash`；Windows 注册 `powershell`，有 Git Bash 时再注册 `bash`。解析不到可执行文件时不注册，避免广告一个必然失败的工具。
- 子 agent 继承父级 `agent.tools`，两个工具自动可用。
- UI 卡片在 [`assistant-message.tsx`](../../../../ui/src/elements/assistant-message.tsx) 共用同一套终端渲染。

## 测试

```bash
vp test packages/agent/tests/tools/shell \
  packages/agent/tests/tools/bash.test.ts \
  packages/agent/tests/tools/powershell.test.ts
```

| 文件                                                          | 覆盖                                                                 |
| ------------------------------------------------------------- | -------------------------------------------------------------------- |
| [resolve.test.ts](../../../tests/tools/shell/resolve.test.ts) | POSIX/Windows 候选顺序、PATH 引号、`PWSH_PATH`、argv 形状            |
| [output.test.ts](../../../tests/tools/shell/output.test.ts)   | 限额内原样、行/字节截断、UTF-8 跨 chunk、spill 内容与上限、幂等      |
| [exec.test.ts](../../../tests/tools/shell/exec.test.ts)       | 退出码、双流、TERM 忽略后的 SIGKILL、abort、预取消、排空、无残留进程 |
| [bash.test.ts](../../../tests/tools/bash.test.ts)             | workdir、非零退出 marker、stderr 分段、截断与 spill、超时、cwd 缺失  |
| [powershell.test.ts](../../../tests/tools/powershell.test.ts) | 解析/argv + Windows 专属 UTF-8 执行（其他平台 skip）                 |

exec/bash 的进程用例只在 POSIX 运行；PowerShell 的真实执行用例需要 Windows。

## 已知边界

- **不提供沙箱、审批、后台任务、持久 shell、流式输出**。这些属于上下文压缩以外的独立能力，当前内核只为一次前台命令服务。
- **shell 状态不跨调用**：每次都是新进程，`cd`、`export`、函数定义都不会保留。
- **不剥离 ANSI**：只通过 `NO_COLOR` / `TERM=dumb` 降低概率；仍需强转义序列的命令可能把控制字符带进正文。
- **stdout/stderr 分开收集**：正文先 stdout 再 `[stderr]` 段，两个流之间的真实交错顺序会丢失。
- **后台孙进程不保证被杀**：正常退出时只做空闲排空，不主动杀进程树；只有超时或取消才会终止整个进程组 / 树。
- **spill 文件跟随会话目录清理**，没有独立的定期清理任务。
- **Windows 的 `bash` 依赖 Git Bash**；没装时只有 `powershell` 工具，这是有意的降级。
