# Shell tool kernel (bash, powershell)

The execution kernel that the `bash` and the `powershell` model tools share. The thin configuration above it lives in [`bash.ts`](../bash.ts) and [`powershell.ts`](../powershell.ts). This directory collects the output, hosts background jobs, and renders the model result. Executable resolution and process lifecycle now live in [`@workspace/sandbox`](../../../../sandbox/README.md): a tool no longer spawns a process, and it gives the command to the sandbox. Every call is a new process. It keeps no cwd, no variable, and no function.

## Module map

| File                             | Responsibility                                                                                                   | Side effect                     |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| [output.ts](./output.ts)         | Keeps the tail, truncates by byte or by line, writes the full output to disk, decodes UTF-8                      | Yes (writes the spill file)     |
| [background.ts](./background.ts) | Output buffer on the producer side of a background command: one ring for each stream, read at an absolute offset | No (memory buffer)              |
| [tool.ts](./tool.ts)             | zod schema, cwd check, foreground and background branch, `ToolOutput` and rendering                              | No (orchestrates the first two) |

The caller needs only `createShellTool()`. `@workspace/sandbox` owns how the process starts and how the shell resolves. This directory only turns a chunk into the body that the model reads.

## Data flow of one call

```text
tool.execute(input)
  ├─ sandbox.resolvePath(workdir ?? primaryProjectDir) + sandbox.stat(cwd)
  ├─ sandbox.exec(command, { cwd, env, timeoutMs, signal, shell })
  │      ├─ stdout/stderr → onData(channel, chunk)
  │      │                 └─ collector.push()   // output.ts
  │      └─ exit + idle drain → { exitCode, signal, timedOut, aborted, durationMs }
  ├─ collector.finish() → { stdout, stderr, truncated, spillPath?, … }
  └─ ToolOutput { output, code: "ok", metadata }
       └─ toModelOutput() → body + status marker
```

`run_in_background: true` takes the other branch. After the same path check and the same argv construction, the command becomes a background job. `onData` writes into the producer-side buffer, not into the collector, and the call returns at once with a job id.

```text
tool.execute(input, run_in_background)
  ├─ path check + shell dialect and variable override (from bash.ts / powershell.ts)
  ├─ createShellStreamBuffer()            // background.ts
  ├─ jobs.start({ kind, label, owner, output, run })
  │    └─ sandbox.exec(...)              no deadline; the job uses its own AbortController
  │         └─ onData → buffer.push() → two rings for stdout and stderr
  └─ ToolOutput { output: "started background job <id>", metadata: { jobId } }
```

## output.ts

| Limit              | Value | Note                                                                      |
| ------------------ | ----- | ------------------------------------------------------------------------- |
| `MAX_OUTPUT_BYTES` | 50KB  | Bytes of the tail that each stream keeps                                  |
| `MAX_OUTPUT_LINES` | 2000  | Lines of the tail that each stream keeps (the first limit to hit applies) |
| `MAX_SPILL_BYTES`  | 64MB  | Spill file limit; after it, only the written part stays                   |
| Scrolling buffer   | 2×    | Each stream keeps 100KB first, for the final truncation by line           |

- Each stream has one streaming `TextDecoder`. A chunk that cuts a multi-byte character makes no broken character.
- Under the limit, the tool returns the text as it is. Over the limit, it takes the tail with [`truncateContent`](../../utils/truncate.ts) and keeps the final newline of the original output.
- When one line is longer than 50KB, no complete line can stay. The tool keeps the last 50KB of bytes, still cut at a UTF-8 boundary.
- Over the limit, the tool writes the original bytes **from the start** to `<sessionDir>/shell/<tool_id>.txt` (`createToolId()` names the file). A failed spill degrades to "no path" and does not change the command result.
- `finish()` is idempotent. An error path can call it to close the spill file.

`ShellOutputSnapshot`:

| Field            | Meaning                                                                                            |
| ---------------- | -------------------------------------------------------------------------------------------------- |
| `stdout`         | The tail of stdout that the tool keeps                                                             |
| `stderr`         | The tail of stderr that the tool keeps                                                             |
| `truncated`      | Whether either stream went over the limit                                                          |
| `spillPath`      | Path of the full output (or of the part within the spill limit)                                    |
| `spillTruncated` | Whether the spill file hit the 64MB limit                                                          |
| `spillFailed`    | Whether the tool could not write the spill at all (the body then holds only the truncation notice) |

## tool.ts

```ts
createShellTool({ description, agentContext, program }): Tool<ShellToolInput, ShellToolOutput, AgentContext>
```

| Input         | Note                                                                                                     |
| ------------- | -------------------------------------------------------------------------------------------------------- |
| `command`     | Non-empty command text. The tool passes it to the shell as one argv element.                             |
| `timeout`     | Milliseconds, positive, default `DEFAULT_TIMEOUT_MS` (2 minutes)                                         |
| `workdir`     | A relative path resolves against the primary project directory; default is the primary project directory |
| `description` | A UI label of 5–10 words, non-empty                                                                      |

The tool checks the working directory with `stat` before it executes. When the directory does not exist, it reports `Working directory does not exist: <path>` and does not spawn.

**Body** (`ToolOutput.output`; the model and the UI both see it):

```text
<stdout>
[stderr]
<stderr>

[output truncated; full output: <path>]
```

When stdout is empty and stderr is empty, the body is `(no output)`. The tool appends the truncation notice last, because the failure reason is usually at the tail.

**Status marker that the model sees** (only `toModelOutput` appends it; the UI shows the summary from metadata):

| marker                      | Trigger condition                             |
| --------------------------- | --------------------------------------------- |
| `[timed out after <N>ms]`   | The executor itself times out                 |
| `[aborted]`                 | The caller cancels                            |
| `[killed by signal: <SIG>]` | A signal ends the process                     |
| `[exit code: <N>]`          | Non-zero exit and no signal ended the process |

**metadata**: `exitCode`, `signal`, `timeout`, `aborted`, `timeoutMs`, `durationMs`, `truncated`, `spillPath?`. The UI [`tool-step.tsx`](../../../../ui/src/blocks/tool-step.tsx) uses these fields to make the `exit N` / `timed out` / `killed by SIG` / `output truncated` summary.

`code` is always `"ok"`. A non-zero exit, a timeout, and a cancel are command results, not tool failures. Only this rule keeps the UI from marking the whole row red. Only an infrastructure error (a failed spawn, a cwd that does not exist) throws.

## Background execution

- **The schema follows the registry.** `run_in_background` enters the zod schema only when `agentContext.jobs` exists. Without a registry, no code can collect that id, and the tool must not promise it to the model.
- **Register first, then spawn.** A refused admission (the session reached its job limit) starts no process.
- **The job owns the cancel, not the caller.** A background job uses its own `AbortController` and does not take the `abortSignal` that `exec` receives: a stop of this turn must not end the work that the model asked to keep. Only `job-kill` or the destroy of the owner ends the process group.
- **No deadline.** When `timeoutMs` is absent, `sandbox.exec` sets no deadline, and the command runs until it ends or someone cancels it.
- **The output goes to a buffer, not to the collector.** A background command therefore has no spill file. It has only the 256 KB tail of [background.ts](./background.ts) and the retention of the job ring. [`jobs`](../../jobs/README.md) does the read, the list, and the cancel.
- **Settlement**: `killed` after a cancel, `completed` after a normal exit (`detail` is `exit code: N`, also for a non-zero exit), `failed` after a failed spawn.

## Composition

- [`bash.ts`](../bash.ts): `shell: "bash"` + the terminal overrides `NO_COLOR/TERM=dumb/PAGER`.
- [`powershell.ts`](../powershell.ts): `shell: "powershell"` + the overrides without `TERM`.
- [`shell-tools.ts`](../../extensions/builtin/shell-tools.ts): registers by `sandbox.describe().shells`. When the sandbox cannot speak the dialect, the tool does not register, so the code does not advertise a tool that must fail.
- [`jobs`](../../jobs/README.md): the process-level job registry and its three control tools. The shell offers background execution only when someone injects it.
- A subagent inherits the `agent.tools` of its parent, so both tools are available to it.
- The UI cards in [`assistant-message.tsx`](../../../../ui/src/blocks/assistant-message.tsx) share one terminal rendering.

## Tests

```bash
vp test packages/agent/tests/tools/shell \
  packages/agent/tests/tools/bash.test.ts \
  packages/agent/tests/tools/powershell.test.ts
```

| File                                                                | Coverage                                                                                                                  |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| [output.test.ts](../../../tests/tools/shell/output.test.ts)         | Text as it is under the limit, truncation by line and by byte, UTF-8 across a chunk, spill content and limit, idempotence |
| [background.test.ts](../../../tests/tools/shell/background.test.ts) | Background start, readable output, cancel ends the process, the schema appears and disappears with the registry           |
| [bash.test.ts](../../../tests/tools/bash.test.ts)                   | workdir, non-zero exit marker, stderr section, truncation and spill, timeout, missing cwd                                 |
| [powershell.test.ts](../../../tests/tools/powershell.test.ts)       | Parse/argv + Windows-only UTF-8 execution (other platforms skip)                                                          |

The cases of the process kernel and of shell resolution moved to `packages/sandbox/tests/`, and they run on POSIX only. A real PowerShell execution case needs Windows.

## Known limits

- **No approval, no persistent shell, no streaming output.** [`@workspace/sandbox`](../../../../sandbox/README.md) owns isolation. [`jobs`](../../jobs/README.md) provides background execution, and this kernel only gives one command to it.
- **Shell state does not cross a call**: every call is a new process, and `cd`, `export`, and a function definition do not stay.
- **No ANSI strip**: the code lowers the chance with `NO_COLOR` / `TERM=dumb` only. A command that forces an escape sequence can still bring a control character into the body.
- **stdout and stderr collect apart**: the body holds stdout first and the `[stderr]` section after it, so the real interleaving of the two streams is lost.
- **A normal exit does not end a grandchild process**: the code does an idle drain only, and only a timeout or a cancel ends the whole process group or tree. A cancel of a background command also ends the process group.
- **A background command writes no spill**: the early output over 256 KB is dropped, and a read marks the loss.
- **The spill file goes with the session directory**, and no separate periodic cleanup task exists.
- **`bash` on Windows depends on Git Bash**; without it, only the `powershell` tool exists, and this degradation is deliberate.
