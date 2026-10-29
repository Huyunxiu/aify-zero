# 上下文压缩（compaction）

把较早的模型历史折叠成一条结构化 checkpoint，模型后续只收到「checkpoint + 标记之后的历史」；数据库和界面保留完整原始对话。自动压缩、手工 `/compact`、provider overflow 三条路径共用这里的投影与摘要内核。

## 术语

| 术语          | 含义                                                          |
| ------------- | ------------------------------------------------------------- |
| 标记 / marker | 时间线上的一个 compaction step，它的位置就是切点              |
| checkpoint    | 模型侧历史开头的合成 user 消息，内容是加上 framing 的摘要     |
| region        | 被摘要替换的半开消息区间 `[start, end)`                       |
| 保留段        | region 之后原样保留的消息                                     |
| shadowed      | 被摘要替换掉的内容，用于计算节省量和展示统计                  |
| 锚点 / anchor | turn 或 step 的第一条模型消息在投影数组中的下标，用于定位切点 |

## 设计目标

- **模型上下文有限，但历史会一直增长。** 对话、工具输出、审批记录都需要在某个点折叠。
- **压缩只改变模型可见历史。** 存储的 turn 和 UI 原文不删除、不改写，用户始终能审计。
- **三条触发路径共用一套内核。** 自动压力压缩、手工 `/compact`、overflow 恢复都走 `projectHistory` + `compactHistory`，避免逻辑漂移。
- **每次压缩可审计。** 留下 `CompactionRecord`：摘要、压缩前后 token、触发原因、摘要模型和它自己的 usage。
- **压缩可以失败。** 摘要失败不写库；自动路径失败只记日志，回合继续。

## 核心不变量

1. **自动压缩的切点是 step 在时间线上的位置；手工压缩的切点写在记录里。** 自动标记把 step 追加/插入 assistant turn；手工压缩的独立 compaction turn 永远线性追加到 branch 末尾，保留段起点由 `record.retainedFromTurnId` 给出。
2. **自动标记之前、或手工记录的保留段之前的内容，只通过摘要进入模型；之后的内容原文保留。**
3. **切点永远落在 step（自动）或 turn（手工）边界。** `tool-call` 和它的 `tool-result` 不会被切开；存在未答复工具调用（等待审批）时不压缩。
4. **记录不复制历史。** `CompactionRecord` 只存摘要、token 统计、触发原因、切点和摘要调用自身的 usage；模型消息由 turns 投影得到。
5. **压缩不改写历史 turn 的内容。** 自动压缩把 step 追加到 assistant turn；手工压缩追加一条独立的 compaction turn，不重排 branch。
6. **最后一个标记胜出。** 投影会先定位最后一个带保留段的手工标记，从它的切点重建；其余标记仍按从左到右重置，更旧的标记自然被覆盖。

```
turns:     u1      a1 [s1  s2  C  s3]      u2      a2 [...]
                                 │
                                 └─ compaction step（切点）

模型侧:    [checkpoint(C)] + [s3, u2, a2, ...]
存储/UI:   u1, a1[s1, s2, C, s3], u2, a2, ...   （原文都在）
```

手工压缩是线性追加，切点在记录里：

```
turns:     u1      a1      u2      a2      S[retainedFromTurnId=u2]
                                            │
                                            └─ 独立 compaction turn

模型侧:    [checkpoint(S)] + [u2, a2]
存储/UI:   u1, a1, u2, a2, S              （branch 顺序不变）
```

## 数据模型

### `CompactionRecord`

定义在 [agent-client/src/types.ts](../../../agent-client/src/types.ts#L45-L62)：

| 字段                              | 用途                                                                          |
| --------------------------------- | ----------------------------------------------------------------------------- |
| `version`                         | 记录格式版本，当前为 `1`                                                      |
| `id`                              | 压缩记录标识；手工路径与 marker part 的 id 一致，自动路径的流事件 id 独立生成 |
| `trigger`                         | `pressure` / `manual` / `overflow`                                            |
| `summary`                         | 模型输出的原始摘要，不带 checkpoint framing                                   |
| `tokensBefore` / `tokensAfter`    | 压缩前后的上下文估算                                                          |
| `shadowedTokens`                  | 被替换内容的估算 token                                                        |
| `shadowedTurns` / `shadowedSteps` | 被替换的 turn / step 数量                                                     |
| `model`                           | 生成摘要的模型                                                                |
| `retainedFromTurnId`              | 手工压缩的保留段起点；缺省表示全量压缩                                        |
| `usage`                           | 摘要调用自身的 usage，不是会话的 usage                                        |
| `createdAt`                       | 记录创建时间；投影用它判断 usage 锚点是否过期                                 |

### 两种标记容器

- **`AgentCompactionStep`**：`type: "compaction"` 的 step，内容是一个 `AgentCompactionPart`，part 的 `record` 携带完整记录。它既可以出现在 assistant turn 内部（自动压缩），也可以出现在独立的 compaction turn 里（手工压缩）。
- **`AgentCompactionTurn`**：只包含一个 compaction step 的独立 turn。它只由手工压缩创建，是 branch 上的一个节点。

两条路径的 part 都从 `compaction.start` 起是 `"streaming"`，`compaction.end` 补上 `record` 后变成 `"done"`。手工压缩现在也走一条自己的流（见下文），所以它的标记同样有真实的起止时间；`createCompactionStep` 仍保留给没有 controller 的轻量调用方（测试），它直接构造 `"done"`。

part 用 `createdAt` / `completedAt` 记录自己的起止时间，界面上的耗时列直接读这个跨度。

### 流事件与 hook

| 事件               | 含义                                                       |
| ------------------ | ---------------------------------------------------------- |
| `compaction.start` | 即将调用摘要模型；带 turn/step，part 以 `"streaming"` 建立 |
| `compaction.end`   | 摘要就绪，带 `record`；把 start 建立的 part 置为 `"done"`  |
| `compaction.error` | 本次压缩失败，历史未变；尚未提交的 part 及其空 step 被撤回 |

`compaction.start` 绑定 placement 决定的 turn/step，`AgentTurnAssembler` 从这一刻起建立 streaming 的 part（[agent-turn-assembler.ts](../../../agent-client/src/agent-turn-assembler.ts#L490-L510)）。摘要失败时 `compaction.error` 按 id 撤回这个 part；step 只用来承载它，part 没了就一起移除。被中止的尝试没有 error 事件，由 `settle` 做同样的清理。这样“开始即可见”和“失败不留标记”可以同时成立。

Hook 侧对应 `compaction.start` 和 `compaction.end`（[hooks-manager.ts](../hooks-manager.ts)）。

## 投影

`projectHistory(turns)` 是模型侧历史的唯一真相（[project.ts](./project.ts#L27-L136)）。它从左到右扫描 turns：

```ts
messages = [];

for (const turn of turns) {
  if (turn.type === "compaction") {
    for (const step of turn.content) resetIfMarker(step);
    continue;
  }

  if (turn.type === "user") {
    append(convertToModelMessages([turn]));
    recordUserAnchor(turn);
    continue;
  }

  for (const step of turn.content) {
    if (step.type === "compaction") {
      resetIfMarker(step);
      continue;
    }
    if (step.type !== "assistant") continue;

    const stepMessages = await convertStepToModelMessages(step);
    append(stepMessages);
    recordStepAnchor(step, stepMessages);
    recordUsageAnchor(step, stepMessages);
  }
}
```

`resetIfMarker` 做四件事：

```ts
messages = [{ role: "user", content: frameCheckpoint(record.summary) }];
turnAnchors = [];
stepAnchors = [];
lastUserTurn = lastAssistantTurnId = undefined;
checkpoint = record;
lastMarkerAt = record.createdAt;
usageAnchor = undefined;
```

因此：

- **最后一个标记胜出**，更早的标记和它前面的内容一起被覆盖。
- **锚点只记录最后一次 reset 之后仍然存在的位置**，因为切点必须落在模型真正会看到的数组里。
- **用户 turn** 走 `convertToModelMessages`；**assistant turn** 逐 step 走 `convertStepToModelMessages`，保证切点能落在 step 边界。
- `convertStepToModelMessages` 把单个 step 包成一条合成 turn，复用 turn 转换器的工具/审批处理，避免两套逻辑（[convert-to-model-message.ts](../utils/convert-to-model-message.ts)）。
- 原始 `convertToModelMessages` 会跳过 compaction turn 和非 assistant step，所以单独调用它也不会产生“半应用”的历史。

### usage 锚点为什么按 `createdAt` 过滤

```ts
if (inputTokens > 0 && step.createdAt > lastMarkerAt) {
  usageAnchor = { messageIndex, inputTokens };
}
```

手工 `recent` 压缩会保留一部分 turn，但这些 turn 创建于压缩之前，它们的 usage 描述的是**压缩前的长 prompt**，不能拿来估算压缩后的上下文。只有最近标记之后产生的 usage 才是有效的压力测量锚点（[project.ts](./project.ts#L109-L121)）。

### checkpoint framing

`frameCheckpoint` 在摘要外包一层说明，并明确告诉模型“这是背景，不要回应它”（[prompt.ts](./prompt.ts#L9-L14)）：

```text
This is an automatically generated checkpoint condensing an earlier span ...
Treat the captured context as established background ...
without acknowledging this checkpoint.

<compacted-summary>
...
</compacted-summary>
```

## 预算与测量

### 策略解析

`resolvePolicy` 为每个模型解析一次策略（[policy.ts](./policy.ts#L28-L124)）：

```text
threshold   = floor(min(contextWindow * thresholdRatio,
                        contextWindow - reserveTokens))
keepRecent  = min(configuredKeepRecent, floor(threshold * 0.5))
```

| 参数                 | 默认值  | 说明                                          |
| -------------------- | ------- | --------------------------------------------- |
| `auto`               | `true`  | 是否允许自动压力压缩；手工压缩始终可用        |
| `thresholdRatio`     | `0.8`   | 限制在 `0.5`–`0.95`                           |
| `reserveTokens`      | `16384` | 给下一次请求预留的空间                        |
| `keepRecentTokens`   | `20000` | 保留段预算；超过 `threshold * 0.5` 时会被夹小 |
| `pruneToolResults`   | `true`  | 是否在摘要前做确定性工具结果剪枝              |
| `maxSummaryTokens`   | `8192`  | 摘要输出上限                                  |
| `minSummarizeTokens` | `2000`  | 固定值；region 小于它时没有摘要价值           |

窗口来自 `aiModel.limit.context`。以下情况会关闭自动压力压缩并写入 `disabledReason`：

- 配置显式关闭 `auto`；
- 模型没有配置上下文窗口；
- `reserveTokens` 吃光了整个窗口；
- 解析出的阈值不是正数。

手工压缩不依赖阈值，仍然可以基于 `keepRecentTokens` 工作。

### 测量口径

`measureContext` 优先使用 provider 回报的真实用量（[select.ts](./select.ts#L13-L41)）：

```text
有 usage 锚点:
  tokens = usage.inputTokens + estimate(messages[anchorIndex..])

没有锚点:
  tokens = estimate(messages) + overhead
```

`overhead` 是系统提示估算加 2000（[agents.ts](../agents.ts#L1063-L1076)）。usage 已经包含系统提示和工具 schema，所以 usage 分支不重复加。

估算本身是“序列化长度 / 4”（[estimate.ts](./estimate.ts#L3-L76)）：

- 图片固定 1500 token，其他文件 200；
- 每条消息额外 4；
- `tool-call` / `tool-result` 的 payload 额外 8；
- 文本按 `ceil(length / 4)`。

`shouldCompact` 的判定是 `tokens >= thresholdTokens`（[policy.ts](./policy.ts#L117-L124)）。

## 自动压缩

自动路径在 [agents.ts](../agents.ts#L579-L615) 和 [agents.ts](../agents.ts#L1063-L1336) 中编排。

### 三种 placement

| 触发       | 时机                                  | 标记位置                   | region 截止点               |
| ---------- | ------------------------------------- | -------------------------- | --------------------------- |
| `pre-turn` | 新 user turn，assistant turn 开始之前 | 上一条 assistant turn 末尾 | `lastUserTurn.messageIndex` |
| `mid-turn` | 第 2 个 step 及之后，每次模型调用之前 | 当前 assistant turn 末尾   | `messages.length`           |
| `overflow` | provider 报上下文超限，收到错误之后   | 当前 assistant turn 末尾   | `messages.length`           |

三种情况都从 `start = checkpoint ? 1 : 0` 开始：旧 checkpoint 本身不进入新的 region，而是作为 `previousSummary` 传给摘要模型。

**pre-turn** 只在新 user turn 之后运行，placement 用 `turns.at(-2)` 找上一条 assistant turn（[select.ts](./select.ts#L50-L70)）。新的用户请求原文保留，被摘要的是它之前的历史。如果前一条不是 assistant turn（例如刚做完手工压缩，head 是 compaction turn），就跳过。

**mid-turn** 把当前 turn 已经流出的文本和工具结果也纳入摘要，之后的 step 从 checkpoint 继续（[select.ts](./select.ts#L72-L83)）。

### 护栏顺序

`#maybeCompact` 依次检查：

1. `auto` 关闭 → 返回（压力路径完全不进入，包括剪枝）；
2. 本 turn 压力压缩达到 3 次 → 返回；
3. 做确定性剪枝；
4. 重新测量；
5. 未达阈值 → 返回；
6. 上次压缩后消息数没有增长、且仍超阈值 → 返回，避免死循环；
7. 存在未答复工具调用（消息层面或 turn 层面）→ 返回；
8. 找不到合法 placement → 返回；
9. region 小于 `minSummarizeTokens` → 返回。

`overflow` 会跳过 `auto`、次数和阈值检查，但仍然受第 3、7、8、9 条约束。

### 写标记的顺序

```text
step.start(compaction)
  → compaction.start（part 以 streaming 建立）
  → summarize + validate
  → compaction.end(record)
  → step.finish(0 usage)
  → session.applyCompaction(checkpoint + retained tail)
  → 计数器 / no-progress guard
  → pre-turn: store.updateTurn(上一条 assistant turn)
  → compaction.end hook
```

- `session.applyCompaction` 把模型消息换成 `[checkpoint, ...messages.slice(regionEnd)]`，并清掉 `lastUsage`：旧的 usage 描述的是已经不存在的 prompt（[agent-session.ts](../agent-session.ts#L58-L82)）。
- 标记 step 由 `step.start` 事件驱动 assembler 追加，part 由紧随其后的 `compaction.start` 建立；没有 controller 的调用（测试）由 `createCompactionStep` 兜底 push。
- 失败时写 `compaction.error` 并记日志，历史不变。自动压缩是优化，不应该导致回合失败。

### overflow 的特殊行为

`isContextOverflowError` 不依赖固定错误码，而是匹配 `context length`、`maximum context`、`too many tokens`、`context_length_exceeded` 等文案，并检查 `message` / `responseBody` / `data` / `cause`（[overflow.ts](./overflow.ts#L11-L52)）。

识别到 overflow 后，`#stepFailure` 会先压缩，然后返回一条错误：

```text
The model's context window was exceeded. The history has been compacted; retry the request.
```

**它不会自动重试。** 压缩完成后由调用方重新发起请求。

## 确定性剪枝

自动路径的第一层是模型无关的 `pruneOlderToolResults`（[prune.ts](./prune.ts#L83-L143)）：

- 从尾部往前累计 `keepRecentTokens`，保护最近的工具结果；最新一条永远保护；
- 只处理 `role === "tool"` 的消息；
- 超过 8192 字符的 `tool-result`，保留前 4096 + 后 1024，中间替换成 `[... tool result middle pruned ...]`；
- 已经是剪枝过的结果直接跳过（幂等）；
- `text` / `error-text` 直接裁剪；`json` / `error-json` 序列化后转成文本；`content` 渲染成文本；`execution-denied` 不动；
- 只改 `tool-result` 的 payload，不改消息结构，因此不会破坏 tool-call/tool-result 配对；
- 只改变内存中的 `session.modelMessages`，不写库，UI 仍然显示完整输出。

剪枝后重新测量；仍然超阈值才调用摘要模型。

## 摘要

### 调用

`SummarizeFn` 是流水线唯一的模型调用，注入的目的是让测试不需要 provider，也允许宿主以后换更小的模型（[types.ts](./types.ts#L95-L99)）。

默认实现是一次 `generateText`（[summarizer.ts](./summarizer.ts#L6-L28)）：

- 使用会话模型；
- `temperature: 0`；
- `maxOutputTokens` 有上限；
- 透传 abort signal。

### prompt

`createSummarizationPrompt` 把消息序列化成**文本**，而不是重放成真实消息前缀（[prompt.ts](./prompt.ts#L234-L282)）。原因：

- 模型收到真实前缀容易顺着继续对话，而不是总结；
- 这个应用面对的 OpenAI-compatible 端点上，provider 前缀缓存并不可靠。

结构：

```text
<previous-checkpoint>
...
</previous-checkpoint>

<conversation>
[User]
...
[Assistant]
...
[Tool result]
...
</conversation>

<固定的结构化摘要指令>
```

摘要格式固定为：`Goal` / `Constraints & Preferences` / `Progress (Done, In Progress, Blocked)` / `Key Decisions` / `Next Steps` / `Critical Context` / `Files and Code`，并要求保留精确路径、函数名、命令、错误信息、标识符和数值。

渲染规则：

- `system` 消息跳过；
- `reasoning` 丢弃；
- 工具结果默认截断到 2000 字符；超出预算时降到 280；
- 文件附件渲染成占位符，图片 / reasoning-file 丢弃；
- 审批请求/结果只留一行标记。

### 摘要自身的预算

```text
maxPromptTokens = max(512, window - maxSummaryTokens - 2000)
maxOutputTokens = window
  ? min(maxSummaryTokens, max(512, floor(window / 8)))
  : maxSummaryTokens
```

如果 prompt 超出预算：

1. 先把 payload 上限从 2000 降到 280；
2. 仍超出时，从最旧的消息开始，每次丢弃约 10%，直到放得下或只剩一条。

`previousSummary` 始终保留在 `<previous-checkpoint>` 里，多轮压缩因此可以合并旧 checkpoint 与新 region，而不是丢掉旧摘要。

### 质量闸门

`compactHistory` 对摘要输出做严格校验（[compact.ts](./compact.ts#L45-L144)）：

1. 摘要非空；
2. `finishReason` 不能是 `length`（被截断的 checkpoint 不可用）；
3. 不能是 `error` / `content-filter`；
4. checkpoint 的估算 token 必须小于被替换内容的 90%（`MIN_SHRINK_RATIO = 0.9`）。

任何一条不满足都抛 `CompactionError`，调用方不写库。

记录字段：

- `tokensBefore`：用 usage 锚点测量整个投影历史；
- `tokensAfter`：checkpoint + region 之后保留段的估算；
- `shadowedTurns` / `shadowedSteps`：按投影锚点统计 region 内的 turn/step 数。

## 手工压缩

### 入口

服务端 `POST /sessions/{sessionId}/compact`，输入 `{ sessionId, model }`（[session.ts](../../../server/src/routers/session.ts)）。它返回 `{ activeStreamId }`，压缩本身在后台跑；客户端随后从 `GET /sessions/{sessionId}/stream` 读事件。

前置条件：

- session 存在；
- 没有正在运行的 stream，`activeStreamId` 为空；
- 没有待审批的工具调用；
- 没有未答复的 `tool-call`。

不满足时返回 `SESSION_BUSY`；没有可压缩内容返回 `NOTHING_TO_COMPACT`。这两个判断都在流创建之前完成，所以调用方不用先拿到 streamId 等一条失败事件。摘要失败发生在流里：`compaction.error` 撤回标记，历史保持原样。

### 选段

`planManualCompaction` 以 **turn 粒度** 选切点（[select.ts](./select.ts#L85-L190)）：

- 从最新 turn 往前累计，直到达到 `keepRecentTokens`，切点落在那个 turn 的起点；
- **永远不会摘要最新的用户请求**：切点落到最新 user turn 之后时，回退到该 user turn；
- 保留段 + 最大摘要仍然超过阈值 → 退化为 `full`（保留段为空）；
- region 小于 `minSummarizeTokens` → 未超阈值返回 `undefined`，超阈值则 `full`；
- branch 为空、找不到可挂载的 head → 超阈值时 `full`。

### 线性追加与切点

| 模式     | `retainedFromTurnId` | branch 拓扑                                       |
| -------- | -------------------- | ------------------------------------------------- |
| `recent` | 第一个保留 turn      | 新 turn C 的 parent 是旧 head；`activeHeadId` → C |
| `full`   | 缺省                 | 同 `recent`；标记之前的内容全部被 checkpoint 替代 |

[`insertTurnInBranch`](../storage/sqlite-store.ts#L216-L243) 只做追加：

```text
insert C (parent = old head)
session.activeHeadId = C
```

`recent` 的切点不再通过改写保留段的 `parentId` 表达，而是写进 `CompactionRecord.retainedFromTurnId`。投影读到最后一个带切点的手工标记时，先放 checkpoint，再从该 turn 开始重建保留段，并跳过这个标记及被它覆盖的更早标记。这样本地“追加在末尾”的 transcript 始终是 branch 的前缀。摘要调用发生在写库之前，失败不会留下任何标记。

### 手工压缩的流

手工压缩和普通回合共用 `Agent.stream` 的入口，只是 `signal` 不同：

```ts
// 普通回合
await agent.stream({ turns, modelId, signal: { type: "turn" }, onFinish });

// 手工压缩
await agent.stream({
  turns,
  modelId,
  signal: { type: "compaction", trigger: "manual" },
  onFinish,
});
```

`Agent` 在流存在之前完成投影和 `planManualCompaction`，所以 `NOTHING_TO_COMPACT` 仍是同步错误。随后后台按普通 turn 的事件顺序写出 `turn.start`（`turnType: "compaction"`）→ `step.start` → `compaction.start` → 摘要 → `compaction.end` → `step.finish` → `turn.finish`，再把 turn 写进 branch，最后才关流并让 `onFinish` 落定会话行。读者读到结尾时，branch 和 `activeStreamId` 都已经是一致的。

客户端只需要读流：压缩 turn 是线性追加的，本地 assembler 追加出来的 transcript 与 branch 一致，不再需要在流结束后用 `listSessionTurns` 替换本地 turns（[session.tsx](../../../ui/src/elements/session.tsx)）。界面不再另存压缩状态：进行中是 transcript 里 streaming 的 compaction part，成功和失败分别用摘要记录和 `compaction.error` 报告。

### `/compact` 命令

UI 在提交前解析 `/compact`；它不接受额外文本。POST 返回后立刻接上该会话的流：transcript 里 streaming 的 compaction part 就是“正在压缩”；成功用摘要记录提示前后 token，失败用 `compaction.error` 提示。自动压缩失败仍只记日志，不打扰用户。上下文环优先使用最近一次压缩的 `tokensAfter`，而不是压缩前的 usage。

## 并发与持久化

手工压缩和“发消息 / 启动回合”会竞争同一条 branch。压缩现在是后台流，准备段返回后它继续跑，所以这里的串行化只靠占用标记和事务：

| 层       | 机制                                 | 防什么                                     |
| -------- | ------------------------------------ | ------------------------------------------ |
| 回合占用 | `activeStreamId` + `STREAM_REGISTRY` | 压缩插入运行中的回合；回合插进运行中的压缩 |
| 数据库   | `insertTurnInBranch` 的事务          | insert / reparent / head 只写了一半        |

准备段一开始就检查占用：`createSession` 发现同一会话还有未结束的流就返回 `SESSION_BUSY`，手工压缩同理。已结束但尚未从注册表摘除的条目不算占用，审批恢复因此不会撞上清理 race。检查到流注册之间没有互斥：两个调用同时进入同一会话时都能通过检查，`activeStreamId` 由后写的一方覆盖。

## 模块地图

| 文件                             | 职责                                | 是否产生副作用           |
| -------------------------------- | ----------------------------------- | ------------------------ |
| [types.ts](./types.ts)           | 记录、策略、投影结构、`SummarizeFn` | 否                       |
| [policy.ts](./policy.ts)         | 阈值/保留预算解析、`shouldCompact`  | 否                       |
| [estimate.ts](./estimate.ts)     | 统一的 token 估算口径               | 否                       |
| [prune.ts](./prune.ts)           | 模型无关的工具结果剪枝              | 否                       |
| [prompt.ts](./prompt.ts)         | checkpoint framing、摘要 prompt     | 否                       |
| [summarizer.ts](./summarizer.ts) | 默认摘要调用（`generateText`）      | 是（模型调用）           |
| [project.ts](./project.ts)       | turns → 模型消息 + 锚点             | 否（只做转换）           |
| [select.ts](./select.ts)         | placement、手工 planner、上下文测量 | 否                       |
| [compact.ts](./compact.ts)       | 摘要 + 校验 + 生成 record           | 是（通过注入的摘要函数） |
| [marker.ts](./marker.ts)         | 构造 compaction step / turn         | 否                       |
| [overflow.ts](./overflow.ts)     | 识别 provider 的上下文超限错误      | 否                       |
| [index.ts](./index.ts)           | 公共导出                            | 否                       |

建议阅读顺序：

```text
types → policy / estimate → project → select → compact → prompt / summarizer
      → marker → overflow → agents.ts 的 #maybeCompact → server 的 compactSession
```

## 测试

单元测试在 `packages/agent/tests/compaction/`，事件装配测试在 `packages/agent-client/tests/compaction.test.ts`。

```bash
vp test packages/agent/tests/compaction packages/agent-client/tests/compaction.test.ts --run
```

覆盖范围：

- policy 的阈值、保留预算和关闭原因；
- estimate 的分片口径；
- prune 的裁剪、保护尾部、幂等；
- project 的 reset、last-marker-wins、usage 锚点、工具配对；
- select 的 pre-turn placement、手工 recent / full / 无事可做；
- compact 的空摘要、截断、未缩小、abort、空区间；
- prompt 的 framing 和预算降级；
- marker 的构造；
- `AgentTurnAssembler` 对 `compaction.start` / `compaction.end` / `compaction.error` 的装配与撤回；
- `Agent.stream` 的 `compaction` signal：独立 turn 的落库位置、无内容时同步失败、abort 后的撤回（[stream-compaction.test.ts](../../tests/stream-compaction.test.ts)）。

测试通过注入 `SummarizeFn` 避免依赖 provider。

## 设计取舍与已知边界

- **剪枝的节省不会立刻反映到压力测量。** 有 usage 锚点时，`measureContext` 用的是上一次请求的 `inputTokens` 加上锚点之后消息的估算；旧工具结果通常位于锚点之前，剪枝改了消息内容却没有改这个数。因此剪枝的收益要到下一次真实调用回报新的 usage 才体现，期间可能多触发一次摘要。
- **overflow 只压缩、不重试。** 压缩后返回错误，由调用方重新发起请求。
- **摘要 prompt 超预算时会丢弃最旧的消息。** 第一次压缩一个巨大 region 时，最早的内容可能既没进摘要、也没有 previous checkpoint 兜底；这是为了让摘要调用本身不爆窗。
- **回合中途压缩的 shadowed 统计可能偏小。** `compactHistory` 用的是 turn 开始时的投影锚点；当前 assistant turn 的 step 还不在锚点里，所以 `shadowedTurns` / `shadowedSteps` 会少计。只影响审计统计，不影响压缩结果。
- **`record.tokensAfter` 不含系统提示和工具 schema 开销。** UI 展示的是纯消息口径；下一次压力测量在没有 usage 锚点时会加上 overhead，两者会有少量差异。
- **before-turn 路径先切换内存态、再写回上一条 assistant turn。** 如果 `store.updateTurn` 失败，catch 只记日志、不回滚内存态；本回合模型看到的是压缩后历史，重载后回到未压缩历史。回合结束时的脏 step 写入通常会补上这次持久化。
- **自动压力压缩每 turn 最多 3 次。** overflow 不受这个上限约束。
- **`auto: false` 时压力路径完全不进入，包括剪枝。** 自动路径里只有 overflow 还会尝试压缩，手工压缩不受影响。
- **手工压缩是后台流，但不会续跑。** 页面断开不影响它（和普通回合一样），`stop` 或进程结束会中止摘要；中止走 `compaction.error`，历史不变。
- **`activeStreamId` 的占用检查不是原子的。** 检查和落库之间没有锁，多进程/多实例共享同一个 SQLite 时不提供跨进程互斥。
