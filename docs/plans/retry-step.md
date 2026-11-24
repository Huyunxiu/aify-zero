# Retry step

Today, when one step fails, the whole turn ends at once with `error`
(`packages/agent/src/kernel/turn-runner.ts:131-142`). One 429 from the provider, or one
connection reset, cancels a turn that already ran some steps. This plan makes the kernel
start one more step in the same turn and request the same thing again. A retry is a step:
it has a record, an upper bound, and it can stop.

The scope stops at a model request failure. The kernel does not retry a tool failure, an
illegal tool call, or a user cancel.

## Decisions

| Decision           | Outcome                                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------------- |
| What a retry is    | One new step in the turn. `stepType` stays `assistant`                                                  |
| Who starts it      | The kernel, automatically. No manual entry, no button                                                   |
| What can retry     | `APICallError.isRetryable`, `StreamProviderError.isRetryable`, and overflow recovery                    |
| SDK retry          | Off. `maxRetries: 0`, `streamRetries: 0`                                                                |
| Budget             | 5 retries per turn (6 requests in total). All failures share it                                         |
| Backoff            | 2 / 4 / 8 / 8 / 8 seconds, capped at 8 seconds. `Retry-After` counts on its own, up to about 60 seconds |
| Retry-After        | Read. The rules copy the SDK                                                                            |
| Visibility         | A `retry` part, one line `Retry 1/5 · 429 Too Many Requests`. It stays after a success                  |
| The failed attempt | No row. The retry step writes its own row as usual                                                      |
| Steering message   | The kernel claims none before a retry step                                                              |

## Domain words

`packages/agent/GLOSSARY.md` now has one more entry: **Retry**. The count applies to
retries only: the first request does not count, and each new request after it counts as
one retry. So the first retry writes `Retry 1/5`, and the last one writes `Retry 5/5`.

## The test

```ts
// packages/agent/src/kernel/retry-policy.ts
export const MAX_RETRIES_PER_TURN = 5;
export const INITIAL_DELAY_MS = 2_000;
export const BACKOFF_FACTOR = 2;
export const MAX_DELAY_MS = 8_000;
```

`isRetryableStepFailure(outcome, error)` checks in this order:

1. `reason === "aborted"` → no.
2. An overflow, and `handleOverflow` returned true → yes. Compaction already repaired the
   history, and the retry ends the recovery that compaction started.
3. `APICallError.isInstance(error) && error.isRetryable` → yes.
4. `StreamProviderError.isInstance(error) && error.isRetryable` → yes.
5. Every other case → no.

A network failure needs no separate line: `handleFetchError` in `@ai-sdk/provider-utils`
folds an error such as `ECONNRESET` into an `APICallError` and sets `isRetryable: true`.

A quota shortage needs no separate line either: the provider marks it as not retryable.
For example, DeepSeek maps `insufficient_quota` to `{ statusCode: 429, isRetryable: false }`.

## Backoff

Retry n waits `min(INITIAL_DELAY_MS * BACKOFF_FACTOR ** (n - 1), MAX_DELAY_MS)`, which is
2 / 4 / 8 / 8 / 8 seconds.

`Retry-After` follows the same rules as the SDK
(`ai/src/util/retry-with-exponential-backoff.ts:48-55`):

- `retry-after-ms` wins over `retry-after`. The second one accepts seconds and also an
  HTTP date.
- The kernel uses the value only when `0 <= ms < 60_000`, or when `ms` is less than the
  current backoff value. Otherwise the kernel uses the exponential backoff.
- An error after the stream starts is a `StreamProviderError`. It has no response headers,
  so it uses the exponential backoff only.

The wait can stop. The wait listens to `context.abortSignal` and ends at once on an abort.

## Loop

`TurnRunner` keeps one turn-level counter, `retries`. When `StepRunner.run` returns
`reason: "error"`:

```
if (retries < MAX_RETRIES_PER_TURN && isRetryableStepFailure(outcome)) {
  retries += 1;
  continue;                    // The next step retries with the retry input
}
status = { status: "error", error };
break;
```

The retry step claims no steering message, and it does no end-of-turn compaction: it skips
both `#applySteering` and `maybeCompact`. Each of the two changes what the kernel sends,
and the retry is then not the same request.

The `error` branch of `StepOutcome` needs one more mark that says the overflow is already
recovered. Today it holds one line of text (`step-runner.ts:581-589`), so the loop cannot
tell this kind of failure from a usual failure. The text also drops the `retry the request`
instruction: the budget decides if the kernel retries, and the text does not command it.

## One step

`StepInput` gains `retry?: { index, maxRetries, reason, delayMs }`. `index` starts at 1.

Order:

1. Write `step.start`. The event carries the retry number, so a hook sees which retry it is.
2. Write `step.retry`. The assembler opens one `retry` part on this step.
3. Wait for `delayMs` and listen to `abortSignal`.
4. `streamText`, with `maxRetries: 0` and `streamRetries: 0` in the arguments
   (`step-runner.ts:346-363`).

The wait comes after `step.start`: the screen gets the step first, and only then can it
draw the row.

## Protocol

```ts
/** One shape for the event, the part and the kernel input. */
export type AgentRetryAttempt = {
  /** The number of this retry, from 1. The first request is not a retry. */
  index: number;
  /** The retries one turn allows; the row shows it as the denominator. */
  maxRetries: number;
  /** The first line of the last failure, cut when it is too long. */
  reason: string;
};

export type AgentRetryPart = AgentRetryAttempt & {
  type: "retry";
  createdAt: number;
};
```

The number of milliseconds to wait stays in the kernel input only (`StepRetryInput`). It
describes this one wait. It is not part of the record, and the screen never shows it.

The new event `step.retry` works the same way as `compaction.start`
(`agent-client/types.ts:288-310`): it carries `turnId` and `stepId`, and the assembler
uses them to build the part on this step.

## Projection and persistence

- The projection must skip it explicitly. Add one branch to the switch in
  `packages/agent/src/utils/convert-to-model-message.ts:183-290` that pushes nothing.
  Without that branch, the code falls to `console.warn("Unsupported part")` at `:286`, and
  every projection warns.
- Persistence needs no change. `transcript-journal.ts:115-127` writes the whole step object
  into `step.content`, and the part goes with it.
- One test decides if a row settles: `storage/step-journal.ts` skips the `step.finish` with
  `status: "error"`. The event still goes out, and the assembler uses it to settle.
- The failed attempt writes no row, but its part may already be drawn. Before the retry,
  the turn loop calls `assembler.settleStep(turnId, stepId)` to settle it in place: the
  call closes the parts of this step only and does not touch the other steps of the same
  turn. A part left as `streaming` gives an old row that turns forever.
- The failed step does not enter the history either: the projection skips a step with
  `status: "error"`. The step is in memory and on the screen, but the model did not finish,
  so the projection does not take it as words that the model said.

## Modules

| Path                                                   | Work                                                                       |
| ------------------------------------------------------ | -------------------------------------------------------------------------- |
| `packages/agent/src/kernel/retry-policy.ts`            | New. The test, the backoff, the constants, and the `Retry-After` parse     |
| `packages/agent/src/kernel/step-runner.ts`             | Turns off the SDK retry; takes the retry input; writes `step.retry`; waits |
| `packages/agent/src/kernel/turn-runner.ts`             | The turn-level budget; on a failure it continues or ends                   |
| `packages/agent/src/hooks-manager.ts`                  | `StepStartEvent` gains `retryIndex`                                        |
| `packages/agent-client/src/types.ts`                   | `AgentRetryPart`, `step.retry`, `isAgentRetryPart`                         |
| `packages/agent-client/src/agent-turn-assembler.ts`    | Handles `step.retry`                                                       |
| `packages/agent/src/utils/convert-to-model-message.ts` | Skips the retry part                                                       |
| `packages/ui/src/blocks/assistant-message.tsx`         | One retry record line                                                      |
| `packages/ui/src/blocks/tool-step.tsx`                 | `getPartStatus` knows `retry`                                              |

## What this plan does not do

- No retry on a tool failure. Today it becomes a `tool.error` for the model
  (`tools/execution.ts:506-547`), and that is correct.
- No retry on an illegal tool call or on a pending approval.
- No manual retry button.
- A request that hangs is not a failure. A timeout turns "a slow model" into "a model
  failure" and needs its own threshold, so it is a separate line of work.
- No use of `streamRetries`. It has no classes and no backoff, and it drops the tool calls
  of the failed attempt (`ai/src/generate-text/stream-text.ts:2931-2988`).

## Acceptance

- The provider returns 429 one time and then succeeds: the turn does not end, and the
  record holds one retry row and one answer.
- The provider returns 401: no retry, the turn goes `error`, and the text does not change.
- The context overflows and compaction succeeds: one automatic retry, with no action from a
  person. The policy layer has a test; the turn level does not have one yet, because it
  needs a history that can really compact. That work is left for later.
- Repeated failures: 6 requests in total (the first one and 5 retries), waits of 2/4/8/8/8
  seconds, and the turn ends with `error` after the last wait. The last row is `Retry 5/5`.
- A stop during the wait: the wait ends at once, the turn goes `aborted`, and the retry
  rows already drawn stay in the record.
- A page refresh: the row of the successful retry is still there, because it settles with
  that step. An aborted turn settles no row at all, so that row stays on the screen of that
  moment only.
- Projection: the `retry` part does not appear in the model message.
- The failed attempt has no step row; the retry step has one.

## Step-by-step work

1. Protocol and types: the `retry` part, the `step.retry` event, `isAgentRetryPart`, and the
   assembler.
2. `retry-policy.ts` and its unit tests: the test, the backoff, and the `Retry-After`
   boundaries.
3. `StepRunner`: turn off the SDK retry, take the retry input, write the event, and wait.
4. `TurnRunner`: the budget and the loop continuation, and the steering skip.
5. The projection skips the retry part, with a test.
6. One line in the UI.
7. Test coverage: `tests/helpers/stream-harness.ts` can make a successful step only now
   (`stepResult()` fixes `finishReason: "stop"`). It must be able to make a failed step.
