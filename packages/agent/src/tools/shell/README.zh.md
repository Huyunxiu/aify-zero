# Shell 工具内核（bash / powershell）

> 中文副本。以 [`README.md`](./README.md) 为准。

`bash` 与 `powershell` 两个模型工具共用的执行内核。上层薄配置在 [`bash.ts`](../bash.ts) 和 [`powershell.ts`](../powershell.ts)；本目录负责输出收集、后台任务托管和模型结果渲染。可执行文件解析与进程生命周期已经搬到 [`@workspace/sandbox`](../../../../sandbox/README.md)：工具不再自己 spawn，只把命令交给沙箱。每次调用都是全新进程，不保留 cwd、变量或函数。

## 模块地图

| 文件                             | 职责                                                       | 副作用              |
| -------------------------------- | ---------------------------------------------------------- | ------------------- |
| [output.ts](./output.ts)         | 尾部保留、按字节/行截断、完整输出落盘、UTF-8 解码          | 是（写 spill 文件） |
| [background.ts](./background.ts) | 后台命令的生产者侧输出缓冲：两条流各一个环，按绝对偏移读取 | 否（内存缓冲）      |
| [tool.ts](./tool.ts)             | zod schema、cwd 校验、前台/后台分支、`ToolOutput` 与渲染   | 否（编排前两者）    |

调用方只需要 `createShellTool()`。进程怎么起、shell 怎么解析归 `@workspace/sandbox`；本目录只管把 chunk 收成可给模型看的正文。

## 一次调用的数据流

```text
tool.execute(input)
  ├─ sandbox.resolvePath(workdir ?? primaryProjectDir) + sandbox.stat(cwd)
  ├─ sandbox.exec(command, { cwd, env, timeoutMs, signal, shell })
  │      ├─ stdout/stderr → onData(channel, chunk)
  │      │                 └─ collector.push()   // output.ts
  │      └─ exit + 空闲排空 → { exitCode, signal, timedOut, aborted, durationMs }
  ├─ collector.finish() → { stdout, stderr, truncated, spillPath?, … }
  └─ ToolOutput { output, code: "ok", metadata }
       └─ toModelOutput() → 正文 + 状态 marker
```

`run_in_background: true` 走另一条分支：同样的路径校验与 argv 构造之后，命令被登记为后台任务，`onData` 写进生产者侧缓冲而不是 collector，调用立刻带着 job id 返回。

```text
tool.execute(input, run_in_background)
  ├─ 路径校验 + 方言与变量覆盖（来自 bash.ts / powershell.ts）
  ├─ createShellStreamBuffer()            // background.ts
  ├─ jobs.start({ kind, label, owner, output, run })
  │    └─ sandbox.exec(...)              无截止时间，用任务自己的 AbortController
  │         └─ onData → buffer.push() → stdout/stderr 两个环
  └─ ToolOutput { output: "started background job <id>", metadata: { jobId } }
```

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

**metadata**：`exitCode`、`signal`、`timeout`、`aborted`、`timeoutMs`、`durationMs`、`truncated`、`spillPath?`。UI 的 [`tool-step.tsx`](../../../../ui/src/blocks/tool-step.tsx) 用这些字段生成 `exit N` / `timed out` / `killed by SIG` / `output truncated` 摘要。

`code` 始终是 `"ok"`：非零退出、超时、取消都是命令结果，不是工具失败；只有这样 UI 才不会把整行标红。只有基础设施错误（spawn 失败、cwd 不存在）才抛异常。

## 后台执行

- **schema 跟着注册表走。** 只有 `agentContext.jobs` 存在时 `run_in_background` 才进 zod schema；没有注册表就没有谁能收走那个 id，工具不该向模型许诺它。
- **先登记后 spawn。** 准入拒绝（该会话的任务已达上限）时不会启动进程。
- **取消权归任务，不归调用方。** 后台用任务自己的 `AbortController`，不接 `exec` 收到的 `abortSignal`：停止这一轮不该杀掉模型要求保留的工作。只有 `job-kill` 或拥有者销毁会终止进程组。
- **没有截止时间。** `sandbox.exec` 在 `timeoutMs` 省略时不设截止时间，命令一直跑到结束或被取消。
- **输出走缓冲，不走 collector。** 所以后台命令没有 spill 文件，只有 [background.ts](./background.ts) 的 256 KB 尾巴和任务环的保留。读取、列表与取消由 [`jobs`](../../jobs/README.md) 负责。
- **结算**：取消后 `killed`，正常退出 `completed`（`detail` 是 `exit code: N`，非零也一样），spawn 失败 `failed`。

## 组合方式

- [`bash.ts`](../bash.ts)：`shell: "bash"` + `NO_COLOR/TERM=dumb/PAGER` 等终端覆盖。
- [`powershell.ts`](../powershell.ts)：`shell: "powershell"` + 不含 `TERM` 的覆盖。
- [`shell-tools.ts`](../../extensions/builtin/shell-tools.ts)：按 `sandbox.describe().shells` 注册。沙箱说不了这种方言就不注册，避免广告一个必然失败的工具。
- [`jobs`](../../jobs/README.md)：进程级任务注册表与三个控制工具；只有它被注入时，shell 才提供后台执行。
- 子 agent 继承父级 `agent.tools`，两个工具自动可用。
- UI 卡片在 [`assistant-message.tsx`](../../../../ui/src/blocks/assistant-message.tsx) 共用同一套终端渲染。

## 测试

```bash
vp test packages/agent/tests/tools/shell \
  packages/agent/tests/tools/bash.test.ts \
  packages/agent/tests/tools/powershell.test.ts
```

| 文件                                                                | 覆盖                                                                |
| ------------------------------------------------------------------- | ------------------------------------------------------------------- |
| [output.test.ts](../../../tests/tools/shell/output.test.ts)         | 限额内原样、行/字节截断、UTF-8 跨 chunk、spill 内容与上限、幂等     |
| [background.test.ts](../../../tests/tools/shell/background.test.ts) | 后台启动、输出可读、取消杀进程、schema 随注册表出现/消失            |
| [bash.test.ts](../../../tests/tools/bash.test.ts)                   | workdir、非零退出 marker、stderr 分段、截断与 spill、超时、cwd 缺失 |
| [powershell.test.ts](../../../tests/tools/powershell.test.ts)       | 解析/argv + Windows 专属 UTF-8 执行（其他平台 skip）                |

进程内核与 shell 解析的用例搬到 `packages/sandbox/tests/`，只在 POSIX 运行；PowerShell 的真实执行用例需要 Windows。

## 已知边界

- **不提供审批、持久 shell、流式输出**。隔离归 [`@workspace/sandbox`](../../../../sandbox/README.md)；后台执行由 [`jobs`](../../jobs/README.md) 提供，本内核只负责把一个命令交给它。
- **shell 状态不跨调用**：每次都是新进程，`cd`、`export`、函数定义都不会保留。
- **不剥离 ANSI**：只通过 `NO_COLOR` / `TERM=dumb` 降低概率；仍需强转义序列的命令可能把控制字符带进正文。
- **stdout/stderr 分开收集**：正文先 stdout 再 `[stderr]` 段，两个流之间的真实交错顺序会丢失。
- **正常退出不杀孙进程**：只做空闲排空；只有超时或取消才终止整个进程组 / 树。后台命令被取消时同样终止进程组。
- **后台命令不落 spill**：超过 256 KB 的早期输出会被淘汰，读取时标出丢失。
- **spill 文件跟随会话目录清理**，没有独立的定期清理任务。
- **Windows 的 `bash` 依赖 Git Bash**；没装时只有 `powershell` 工具，这是有意的降级。
