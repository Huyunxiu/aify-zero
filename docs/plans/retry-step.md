# 重试步方案

一步失败之后，今天整个回合立刻以 `error` 结束（`packages/agent/src/kernel/turn-runner.ts:131-142`）。
供应商的一次 429、一次连接重置，就把已经跑了几步的回合作废。这个方案让内核在同一个
回合里再开一步、重新请求同一个。重试是一步：有记录、有上界、可中止。

范围只到模型请求的失败。工具失败、非法工具调用、用户取消都不重试。

## 决策

| 决策        | 结论                                                                      |
| ----------- | ------------------------------------------------------------------------- |
| 重试是什么  | 回合内新开的一步，`stepType` 仍是 `assistant`                             |
| 谁发起      | 内核自动。没有手动入口，没有按钮                                          |
| 什么可重试  | `APICallError.isRetryable`、`StreamProviderError.isRetryable`，加溢出恢复 |
| SDK 重试    | 关掉。`maxRetries: 0`、`streamRetries: 0`                                 |
| 预算        | 每回合 5 次重试（共 6 次请求），所有失败共用                              |
| 退避        | 2 / 4 / 8 / 8 / 8 秒，封顶 8 秒；`Retry-After` 另算，最长约 60 秒         |
| Retry-After | 读，规则照抄 SDK                                                          |
| 可见性      | `retry` part，一行 `Retry 1/5 · 429 Too Many Requests`，成功之后保留      |
| 失败的那次  | 不落行。重试步自己正常落行                                                |
| 引导消息    | 重试步之前不领                                                            |

## 领域词

`packages/agent/GLOSSARY.md` 已加一条：**重试 (Retry)**。次数只在重试上算：第一次
请求不算，之后每一次重新请求都算一次重试。所以第一次重试写 `Retry 1/5`，最后
一次写 `Retry 5/5`。

## 判定

```ts
// packages/agent/src/kernel/retry-policy.ts
export const MAX_RETRIES_PER_TURN = 5;
export const INITIAL_DELAY_MS = 2_000;
export const BACKOFF_FACTOR = 2;
export const MAX_DELAY_MS = 8_000;
```

`isRetryableStepFailure(outcome, error)` 按顺序判断：

1. `reason === "aborted"` → 否。
2. 溢出，且 `handleOverflow` 返回过 true → 是。压缩已经修好历史，重试就是它要的收尾。
3. `APICallError.isInstance(error) && error.isRetryable` → 是。
4. `StreamProviderError.isInstance(error) && error.isRetryable` → 是。
5. 其余 → 否。

网络失败不用单列：`@ai-sdk/provider-utils` 的 `handleFetchError` 把 `ECONNRESET`
这类错误折成 `APICallError`，并标 `isRetryable: true`。

配额不足也不用单列：供应商自己会标不可重试，例如 DeepSeek 把 `insufficient_quota`
映射成 `{ statusCode: 429, isRetryable: false }`。

## 退避

第 n 次重试等 `min(INITIAL_DELAY_MS * BACKOFF_FACTOR ** (n - 1), MAX_DELAY_MS)`，
即 2 / 4 / 8 / 8 / 8 秒。

`Retry-After` 与 SDK 同一套规则（`ai/src/util/retry-with-exponential-backoff.ts:48-55`）：

- `retry-after-ms` 优先于 `retry-after`；后者接受秒数，也接受 HTTP 日期。
- 只在 `0 <= ms < 60_000`，或 `ms` 小于当前退避值时才采用；否则回落。
- 流开始后的错误是 `StreamProviderError`，它没有响应头，所以只用指数退避。

等待可中止：等待听 `context.abortSignal`，中止就立刻结束。

## 循环

`TurnRunner` 保留一个回合级计数 `retries`。`StepRunner.run` 返回 `reason: "error"` 时：

```
if (retries < MAX_RETRIES_PER_TURN && isRetryableStepFailure(outcome)) {
  retries += 1;
  continue;                    // 下一步带着 retry 输入重试
}
status = { status: "error", error };
break;
```

重试那一步不领引导消息、也不做回合末压缩：`#applySteering` 与 `maybeCompact`
两段都跳过。两者都会改掉要发出去的东西，重试就不再是同一个请求了。

`StepOutcome` 的 `error` 分支要加一个标记，说明溢出已经恢复。今天它只是一条文案
（`step-runner.ts:581-589`），循环读不出这一种和普通失败的差别。文案同时去掉
「retry the request」那句指令：要不要重试由预算决定，不由文案指挥。

## 一步

`StepInput` 加 `retry?: { index, maxRetries, reason, delayMs }`，`index` 从 1 起。

顺序：

1. 写 `step.start`，第几次重试随事件发出，钩子看到这是第几次重试。
2. 写 `step.retry`，装配器在这一步上开一个 `retry` part。
3. 按 `delayMs` 等待，听 `abortSignal`。
4. `streamText`，参数加 `maxRetries: 0`、`streamRetries: 0`（`step-runner.ts:346-363`）。

等待放在 `step.start` 之后：屏幕上先有一步，行才画得出来。

## 协议

```ts
/** 事件、part、内核的输入共用这一份。 */
export type AgentRetryAttempt = {
  /** 第几次重试，从 1 起。第一次请求不算重试。 */
  index: number;
  /** 一个回合允许的重试次数；行上的分母就是它。 */
  maxRetries: number;
  /** 上一次失败的首行，过长截断。 */
  reason: string;
};

export type AgentRetryPart = AgentRetryAttempt & {
  type: "retry";
  createdAt: number;
};
```

等待多少毫秒只留在内核的输入里（`StepRetryInput`）：它描述这一次等待，不是
记录的一部分，屏幕上也从不显示它。

新事件 `step.retry`，与 `compaction.start` 同路数（`agent-client/types.ts:288-310`）：
带 `turnId`、`stepId`，装配器据此在这一步上建 part。

## 投影与持久化

- 投影要显式跳过。`packages/agent/src/utils/convert-to-model-message.ts:183-290` 的
  switch 加一个分支，什么都不 push。不加就会落到 `:286` 的
  `console.warn("Unsupported part")`，每次投影都告警。
- 持久化不用改。`transcript-journal.ts:115-127` 把整个 step 对象写进 `step.content`，
  part 跟着走。
- 落行与否只有一处判据：`storage/step-journal.ts` 跳过 `status: "error"` 的
  `step.finish`。事件照发，装配器靠它收尾。
- 失败的那一次不落行，但它的 part 可能已经画出来了。重试之前由回合循环调
  `assembler.settleStep(turnId, stepId)` 就地收尾：只关这一步的 part，不动同一
  回合的其他步。留着 `streaming` 会得到一个永远转圈的旧行。
- 失败的那一步也不进历史：投影跳过 `status: "error"` 的步。它在内存里、在屏幕
  上，但模型没有说完，不能当成它说过的话。

## 模块

| 路径                                                   | 职责                                                |
| ------------------------------------------------------ | --------------------------------------------------- |
| `packages/agent/src/kernel/retry-policy.ts`            | 新增。判定、退避、常量、`Retry-After` 解析          |
| `packages/agent/src/kernel/step-runner.ts`             | 关掉 SDK 重试；接 retry 输入；写 `step.retry`；等待 |
| `packages/agent/src/kernel/turn-runner.ts`             | 回合级预算；失败时继续或结束                        |
| `packages/agent/src/hooks-manager.ts`                  | `StepStartEvent` 加 `retryIndex`                    |
| `packages/agent-client/src/types.ts`                   | `AgentRetryPart`、`step.retry`、`isAgentRetryPart`  |
| `packages/agent-client/src/agent-turn-assembler.ts`    | 处理 `step.retry`                                   |
| `packages/agent/src/utils/convert-to-model-message.ts` | 跳过 retry part                                     |
| `packages/ui/src/elements/assistant-message.tsx`       | 一行重试记录                                        |
| `packages/ui/src/elements/tool-step.tsx`               | `getPartStatus` 认 `retry`                          |

## 不做什么

- 工具失败不重试。它今天变成 `tool.error` 交给模型（`tools/execution.ts:506-547`），这是对的。
- 非法工具调用、审批挂起不重试。
- 手动重试按钮不做。
- 请求挂住不算失败。超时会把「模型慢」变成「模型失败」，需要自己的阈值，另开一条。
- `streamRetries` 不用。它没有分类、没有退避，还会丢掉失败那次的工具调用
  （`ai/src/generate-text/stream-text.ts:2931-2988`）。

## 验收

- 供应商返回 429 一次后成功：回合不结束，记录里有一行重试和一条答复。
- 供应商返回 401：不重试，回合 `error`，文案不变。
- 上下文溢出且压缩成功：自动重试一次，不需要人动手。
  策略层有测试；回合级还没有——它需要一段真能压缩的历史，留作后续。
- 连续失败：共 6 次请求（第一次加 5 次重试），等待 2/4/8/8/8 秒，最后一次等完按
  `error` 结束。最后一行是 `Retry 5/5`。
- 等待中按停止：等待立刻结束，回合 `aborted`，已画出的重试行留在记录里。
- 刷新页面：重试成功的那一行还在（它随那一步落行）。中止的回合整轮不落行，
  那一行只留在当时的屏幕上。
- 投影：`retry` part 不出现在模型消息里。
- 失败的那次重试没有 step 行；重试步有。

## 分步实施

1. 协议与类型：`retry` part、`step.retry` 事件、`isAgentRetryPart`、装配器。
2. `retry-policy.ts` 与单元测试：判定、退避、`Retry-After` 边界。
3. `StepRunner`：关掉 SDK 重试，接 retry 输入，写事件，等待。
4. `TurnRunner`：预算与循环继续，跳过 steering。
5. 投影跳过 retry part，加测试。
6. UI 一行。
7. 测试补全：`tests/helpers/stream-harness.ts` 现在只能造成功步
   （`stepResult()` 固定 `finishReason: "stop"`），要能造失败步。
