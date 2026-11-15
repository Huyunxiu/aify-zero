# Sandbox

工具在哪跑：一个沙箱同时给出文件访问和命令执行两件事，工具只认这个面，不认具体
环境。本包只放契约、本机适配器和契约测试；具体环境的适配器将来加在 `src/host/` 旁边。

## 契约

`src/types.ts` 是唯一规范，它的注释就是行为定义，这里不重复。三条最容易看错的：

- **完成即结果，传输失败才抛。** 非零退出码、超时、取消都通过 `ExecResult` 的字段
  表达；只有进程起不来（可执行文件或目录不存在、权限不足）才 reject。
- **`exists` 永不抛。** 不存在、读不了、没权限都返回 `false`；要区分原因用 `stat`。
- **`stat` 不许编造。** 适配器拿不到的字段必须省略，占位值会把工具分支带错。

## 本机适配器

`createHostSandbox(input)` / `createHostSandboxAdapter()`。它把当前进程所在的机器
映射成沙箱：文件动词直连 `node:fs/promises`，命令走本包的进程内核，环境变量原样
透传（`{ ...process.env, ...options.env }`）。它**不提供任何隔离**。

`describe().shells` 每次调用都重新探测可执行文件：装了 Git Bash 的 Windows 上
`bash` 和 `powershell` 都在，只有 pwsh 时只有 `powershell`。工具注册按这个数组裁。

## 原生隔离适配器

`createIsolatedSandboxAdapter()` / `probeNativeIsolation()`。它在上面这个本机适配器
外面套一层平台自带的约束：

| 平台  | 手段                               | 效果               |
| ----- | ---------------------------------- | ------------------ |
| macOS | `sandbox-exec` + seatbelt 策略     | 命令只能写进可写根 |
| Linux | `bwrap` 只读挂 `/`，再 bind 可写根 | 同上               |

可写根来自 `buildWritePolicy`：项目目录、会话目录、`TMPDIR`、`/tmp`、`~/.npm`、
`~/.cache`、`~/Library/Caches`，外加调用方给的额外根。不放行临时目录和构建缓存，
`npm install` 和编译器会直接撞只读错误。

两件刻意不做：**不限制网络**（`npm install`、`git fetch` 是基本需求），**不限制读取**
（读凭证要配网络才有意义，限制读取会直接弄坏 `git push` 和 `ssh`）。所以它是写保护，
不是完整的机密性边界。

**写入也受约束**：`writeFile` / `mkdir` / `rm` 会先用 `isWritablePath` 检查目标，越界抛
`SandboxWriteDeniedError`。检查前先解析符号链接，所以工作区里放一个指向外面的链接也不能
绕过。读取不受限——和「不限制读取」这条取舍一致。

**已知缺口**：约束只覆盖命令和这三个写动词。spill 文件由 server 进程写，不受策略约束；
要连读取一起隔离，得换成整个进程在容器里的适配器。

**探测而不是假设**：`acquire` 会真的起一个探针进程验证平台能套上约束。`sandbox-exec`
在部分环境里存在但 `sandbox_apply` 会被外层策略拒绝（本仓库的开发机就是如此，退出码
71），只看二进制在不在会让每条命令都失败在 `Operation not permitted`。探测失败时
`acquire` 抛错，**不退回无隔离执行**（见 `docs/adr/0008`）。

## 进程内核（`src/exec.ts`）

`runShell(options: ShellRunOptions): Promise<ShellRunResult>`

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

- `spawn` 失败（可执行文件或 cwd 不存在、权限不足）→ Promise reject。
- 非零退出、超时、取消 → 正常 resolve，由结果字段表达。
- 进程退出码为 `null` 表示被信号终止，`signal` 携带信号名。

## shell 解析（`src/host/resolve.ts`）

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

## 契约测试

`describeSandboxContract({ name, create })` 定义每个适配器都要满足的语义，断言只
来自 `types.ts` 的注释。新适配器先跑它，再写自己的用例。

```bash
vp test packages/sandbox
```

| 文件                                       | 覆盖                                                                 |
| ------------------------------------------ | -------------------------------------------------------------------- |
| [host.test.ts](./tests/host.test.ts)       | 契约 + 本机适配器的 fs/exec 细节、符号链接、readHead、readTextStream |
| [fake.test.ts](./tests/fake.test.ts)       | 契约 ×3（标准 / 无 shell / 缺可选能力）+ 假适配器自身                |
| [resolve.test.ts](./tests/resolve.test.ts) | POSIX/Windows 候选顺序、PATH 引号、`PWSH_PATH`、argv 形状            |
| [exec.test.ts](./tests/exec.test.ts)       | 退出码、双流、TERM 忽略后的 SIGKILL、abort、预取消、排空、无残留进程 |
