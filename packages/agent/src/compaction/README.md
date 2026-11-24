# Context compaction

Compaction folds the older model history into one structured checkpoint. The model then receives only the checkpoint and the history after the marker. The database and the interface keep the complete original conversation. Three paths share the projection and the summary kernel here: automatic compaction, the manual `/compact` command, and provider overflow.

## Terms

| Term             | Meaning                                                                                                           |
| ---------------- | ----------------------------------------------------------------------------------------------------------------- |
| marker           | One compaction step on the timeline. Its position is the cut point.                                               |
| checkpoint       | The synthetic user message at the start of the model-side history. Its content is the summary with framing added. |
| region           | The half-open message interval `[start, end)` that the summary replaces.                                          |
| retained segment | The messages after the region that stay as they are.                                                              |
| shadowed         | The content that the summary replaced. The code uses it to count the saving and to show statistics.               |
| anchor           | The index of the first model message of a turn or a step in the projection array. It locates the cut point.       |

## Design goals

- **The model context is limited, but the history keeps growing.** The conversation, the tool output, and the approval records must all fold at some point.
- **Compaction changes only the model-visible history.** It does not delete or rewrite the stored turns and the interface text. The user can audit them at any time.
- **The three trigger paths share one kernel.** Automatic pressure compaction, the manual `/compact` command, and overflow recovery all use `projectHistory` + `compactHistory`. This keeps the logic from drifting apart.
- **Every compaction is auditable.** It leaves a `CompactionRecord`: the summary, the token counts before and after, the trigger reason, the summarizer model, and the usage of that call.
- **Compaction can fail.** A failed summary writes nothing to the store. On the automatic path a failure only writes a log line, and the turn continues.

## Core invariants

1. **The cut point of an automatic compaction is the position of a step on the timeline. The cut point of a manual compaction is in the record.** An automatic marker appends or inserts the step into an assistant turn. The separate compaction turn of a manual compaction always appends linearly to the end of the branch, and `record.retainedFromTurnId` gives the start of the retained segment.
2. **Content before an automatic marker, or before the retained segment of a manual record, enters the model only through the summary. Content after it stays as the original text.**
3. **A cut point always falls on a step boundary (automatic) or a turn boundary (manual).** Nothing splits a `tool-call` from its `tool-result`. The code does not compact while an unanswered tool call waits for an approval.
4. **A record does not copy the history.** `CompactionRecord` holds only the summary, the token counts, the trigger reason, the cut point, and the usage of the summary call itself. The projection builds the model messages from the turns.
5. **Compaction does not rewrite the content of a history turn.** An automatic compaction appends a step to an assistant turn. A manual compaction appends a separate compaction turn and does not reorder the branch.
6. **The last marker wins.** The projection first finds the last manual marker that has a retained segment, and rebuilds from its cut point. The other markers still reset in left-to-right order, so an older marker is covered in turn.

```
turns:     u1      a1 [s1  s2  C  s3]      u2      a2 [...]
                                 │
                                 └─ compaction step (cut point)

model side: [checkpoint(C)] + [s3, u2, a2, ...]
store/UI:   u1, a1[s1, s2, C, s3], u2, a2, ...   (the source text stays)
```

A manual compaction appends linearly, and the cut point is in the record:

```
turns:     u1      a1      u2      a2      S[retainedFromTurnId=u2]
                                            │
                                            └─ separate compaction turn

model side: [checkpoint(S)] + [u2, a2]
store/UI:   u1, a1, u2, a2, S              (the branch order does not change)
```

## Data model

### `CompactionRecord`

It is defined in [agent-client/src/types.ts](../../../agent-client/src/types.ts#L45-L62):

| Field                             | Purpose                                                                                                                                                                    |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`                         | The record format version. The current value is `1`.                                                                                                                       |
| `id`                              | The identifier of the compaction record. On the manual path it matches the id of the marker part. On the automatic path the code generates the stream event id separately. |
| `trigger`                         | `pressure` / `manual` / `overflow`                                                                                                                                         |
| `summary`                         | The raw summary from the model, without the checkpoint framing.                                                                                                            |
| `tokensBefore` / `tokensAfter`    | The context estimates before and after the compaction.                                                                                                                     |
| `shadowedTokens`                  | The estimated tokens of the replaced content.                                                                                                                              |
| `shadowedTurns` / `shadowedSteps` | The count of the replaced turns and steps.                                                                                                                                 |
| `model`                           | The model that makes the summary.                                                                                                                                          |
| `retainedFromTurnId`              | The start of the retained segment of a manual compaction. When it is absent, the compaction covers all turns.                                                              |
| `usage`                           | The usage of the summary call itself, not the usage of the session.                                                                                                        |
| `createdAt`                       | The creation time of the record. The projection uses it to test if a usage anchor is stale.                                                                                |

### The two marker containers

- **`AgentCompactionStep`**: A step with `type: "compaction"`. Its content is one `AgentCompactionPart`, and the `record` of the part holds the complete record. It can occur inside an assistant turn (automatic compaction) or in a separate compaction turn (manual compaction).
- **`AgentCompactionTurn`**: A separate turn that holds one compaction step. Only a manual compaction creates it. It is one node on the branch.

On both paths the part is `"streaming"` from `compaction.start`, and it becomes `"done"` when `compaction.end` adds the `record`. A manual compaction now also runs its own stream (see below), so its marker has real start and end times too. `createCompactionStep` stays for a light caller without a controller (a test): it builds a `"done"` part directly.

The part records its own start and end time with `createdAt` / `completedAt`. The duration column in the interface reads this span directly.

### Stream events and hooks

| Event              | Meaning                                                                                                                       |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `compaction.start` | The summarizer model is about to run. The event carries the turn and the step, and the code builds the part as `"streaming"`. |
| `compaction.end`   | The summary is ready, and the event carries the `record`. It sets the part from the start event to `"done"`.                  |
| `compaction.error` | This compaction failed and the history did not change. The code withdraws the uncommitted part and its empty step.            |

`compaction.start` binds to the turn and the step that the placement selected, and `AgentTurnAssembler` builds the streaming part from that moment ([agent-turn-assembler.ts](../../../agent-client/src/agent-turn-assembler.ts#L490-L510)). When the summary fails, `compaction.error` withdraws this part by id. The step only carries the part, so it goes away with the part. An aborted attempt has no error event, and `settle` does the same cleanup. This keeps both properties at the same time: the part is visible at the start, and a failure leaves no marker.

The hooks `pre_compact` and `post_compact` match these events ([hooks-manager.ts](../hooks-manager.ts)).

## Projection

`projectHistory(turns)` is the only source of truth for the model-side history ([project.ts](./project.ts#L27-L136)). It scans the turns from left to right:

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

`resetIfMarker` does four things:

```ts
messages = [{ role: "user", content: frameCheckpoint(record.summary) }];
turnAnchors = [];
stepAnchors = [];
lastUserTurn = lastAssistantTurnId = undefined;
checkpoint = record;
lastMarkerAt = record.createdAt;
usageAnchor = undefined;
```

As a result:

- **The last marker wins.** It covers an earlier marker together with the content before that marker.
- **An anchor records only a position that still exists after the last reset**, because the cut point must fall in the array that the model really sees.
- A **user turn** goes through `convertToModelMessages`. An **assistant turn** goes through `convertStepToModelMessages`, step by step, so the cut point can fall on a step boundary.
- `convertStepToModelMessages` wraps one step in a synthetic turn. It reuses the tool and approval handling of the turn converter, so there is no second logic ([convert-to-model-message.ts](../utils/convert-to-model-message.ts)).
- The original `convertToModelMessages` skips a compaction turn and a non-assistant step, so a direct call to it cannot make a half-applied history either.

### Why the usage anchor filters by `createdAt`

```ts
if (inputTokens > 0 && step.createdAt > lastMarkerAt) {
  usageAnchor = { messageIndex, inputTokens };
}
```

A manual `recent` compaction keeps some turns. These turns were created before the compaction, so their usage describes the **long prompt before the compaction**. The code cannot use it to estimate the context after the compaction. Only a usage that occurs after the latest marker is a valid anchor for the pressure measurement ([project.ts](./project.ts#L109-L121)).

### checkpoint framing

`frameCheckpoint` puts one instruction around the summary, and it tells the model that this is background and that it must not answer it ([prompt.ts](./prompt.ts#L9-L14)):

```text
This is an automatically generated checkpoint condensing an earlier span ...
Treat the captured context as established background ...
without acknowledging this checkpoint.

<compacted-summary>
...
</compacted-summary>
```

## Budget and measurement

### Policy resolution

`resolvePolicy` resolves the policy one time for each model ([policy.ts](./policy.ts#L28-L124)):

```text
threshold   = floor(min(contextWindow * thresholdRatio,
                        contextWindow - reserveTokens))
keepRecent  = min(configuredKeepRecent, floor(threshold * 0.5))
```

| Parameter            | Default | Description                                                                                |
| -------------------- | ------- | ------------------------------------------------------------------------------------------ |
| `auto`               | `true`  | If automatic pressure compaction is allowed. A manual compaction is always available.      |
| `thresholdRatio`     | `0.8`   | It is limited to `0.5`–`0.95`.                                                             |
| `reserveTokens`      | `16384` | The space that the next request reserves.                                                  |
| `keepRecentTokens`   | `20000` | The budget of the retained segment. The code clamps it when it is above `threshold * 0.5`. |
| `pruneToolResults`   | `true`  | If deterministic tool result pruning occurs before the summary.                            |
| `maxSummaryTokens`   | `8192`  | The upper limit of the summary output.                                                     |
| `minSummarizeTokens` | `2000`  | A fixed value. A region below it has no value for a summary.                               |

The policy is not part of the kernel: the kernel reads
[CompactionStrategy](../kernel/compaction-strategy.ts) through `Capabilities.compaction`. By default
[CompactionExtension](../extensions/builtin/compaction.ts) supplies it from the model window and the switch in the user
settings. The kernel decides only when to check and how to write back. The threshold and the summary prompt belong to the policy.

The window comes from the model table in the host configuration (`context.modelContextWindows`). The code turns off automatic pressure compaction and writes a `disabledReason` in these cases:

- The configuration turns `auto` off explicitly.
- The model has no context window in the configuration.
- `reserveTokens` uses the whole window.
- The resolved threshold is not a positive number.

A manual compaction does not depend on the threshold, and it can still work from `keepRecentTokens`.

### Measurement

`measureContext` prefers the real usage that the provider reports ([select.ts](./select.ts#L13-L41)):

```text
with a usage anchor:
  tokens = usage.inputTokens + estimate(messages[anchorIndex..])

without an anchor:
  tokens = estimate(messages) + overhead
```

`overhead` is the system prompt estimate plus 2000 ([agents.ts](../agents.ts#L1063-L1076)). The usage already holds the system prompt and the tool schemas, so the usage branch does not add them again.

The estimate itself is the serialized length divided by 4 ([estimate.ts](./estimate.ts#L3-L76)):

- An image counts 1500 tokens, and another file counts 200.
- Each message adds 4.
- The payload of a `tool-call` / `tool-result` adds 8.
- Text counts `ceil(length / 4)`.

`shouldCompact` tests `tokens >= thresholdTokens` ([policy.ts](./policy.ts#L117-L124)).

## Automatic compaction

The automatic path is arranged in [agents.ts](../agents.ts#L579-L615) and [agents.ts](../agents.ts#L1063-L1336).

### The three placements

| Trigger    | Moment                                                           | Marker position                        | Region end                  |
| ---------- | ---------------------------------------------------------------- | -------------------------------------- | --------------------------- |
| `pre-turn` | A new user turn, before the assistant turn starts                | The end of the previous assistant turn | `lastUserTurn.messageIndex` |
| `mid-turn` | From the second step on, before each model call                  | The end of the current assistant turn  | `messages.length`           |
| `overflow` | After an error that reports a context overflow from the provider | The end of the current assistant turn  | `messages.length`           |

All three cases start from `start = checkpoint ? 1 : 0`. The old checkpoint does not enter the new region; the code passes it to the summary model as `previousSummary`.

**pre-turn** runs only after a new user turn, and the placement uses `turns.at(-2)` to find the previous assistant turn ([select.ts](./select.ts#L50-L70)). The new user request stays as the original text, and the history before it is what the summary covers. If the previous turn is not an assistant turn, for example after a manual compaction where the head is a compaction turn, the code skips this placement.

**mid-turn** also includes the text and the tool results that the current turn already streamed. The later steps continue from the checkpoint ([select.ts](./select.ts#L72-L83)).

### Guard order

`#maybeCompact` checks in this order:

1. `auto` is off → return. The pressure path does not run at all, including the pruning.
2. This turn reached 3 pressure compactions → return.
3. Run the deterministic pruning.
4. Measure again.
5. The threshold is not reached → return.
6. The message count did not grow after the last compaction and the threshold is still exceeded → return, to avoid an endless loop.
7. An unanswered tool call exists, at the message level or at the turn level → return.
8. No valid placement exists → return.
9. The region is below `minSummarizeTokens` → return.

`overflow` skips the `auto` check, the count check, and the threshold check. Steps 3, 7, 8, and 9 still apply to it.

### The order that writes the marker

```text
step.start(compaction)
  → compaction.start (the code builds the part as streaming)
  → summarize + validate
  → compaction.end(record)
  → step.finish(0 usage)
  → session.applyCompaction(checkpoint + retained tail)
  → counter / no-progress guard
  → pre-turn: store.updateTurn(previous assistant turn)
  → post_compact hook
```

- `session.applyCompaction` replaces the model messages with `[checkpoint, ...messages.slice(regionEnd)]`, and it clears `lastUsage`, because the old usage describes a prompt that no longer exists ([agent-session.ts](../agent-session.ts#L58-L82)).
- The `step.start` event drives the assembler to append the marker step, and the `compaction.start` event right after it builds the part. For a call without a controller (a test), `createCompactionStep` pushes the step as a fallback.
- On a failure the code writes `compaction.error` and a log line, and the history does not change. Automatic compaction is an optimization, so it must not fail the turn.

### The special behavior of overflow

`isContextOverflowError` does not depend on a fixed error code. It matches text such as `context length`, `maximum context`, `too many tokens`, and `context_length_exceeded`, and it checks `message` / `responseBody` / `data` / `cause` ([overflow.ts](./overflow.ts#L11-L52)).

After it identifies an overflow, `#stepFailure` compacts first and then returns an error:

```text
The model's context window was exceeded. The history has been compacted; retry the request.
```

**It does not retry automatically.** The caller sends the request again after the compaction completes.

## Deterministic pruning

The first layer of the automatic path is `pruneOlderToolResults`, which does not depend on the model ([prune.ts](./prune.ts#L83-L143)):

- It counts `keepRecentTokens` from the tail to the front and protects the recent tool results. It always protects the newest one.
- It handles only a message with `role === "tool"`.
- For a `tool-result` above 8192 characters, it keeps the first 4096 and the last 1024, and it replaces the middle with `[... tool result middle pruned ...]`.
- It skips a result that is already pruned (idempotent).
- It trims `text` / `error-text` directly. It serializes `json` / `error-json` into text. It renders `content` into text. It does not touch `execution-denied`.
- It changes only the payload of the `tool-result`, not the message structure, so it cannot break the tool-call and tool-result pair.
- It changes only `session.modelMessages` in memory and does not write to the store. The interface still shows the complete output.

The code measures again after the pruning, and it calls the summary model only if the threshold is still exceeded.

## The summary

### The call

`SummarizeFn` is the only model call in the pipeline. The code injects it so that a test needs no provider, and so that the host can use a smaller model later ([types.ts](./types.ts#L95-L99)).

The compaction policy supplies the summarizer (`CompactionStrategy.summarize`). The default implementation is one
`generateText` call ([summarizer.ts](./summarizer.ts#L6-L28)):

- It uses the session model.
- `temperature: 0`
- `maxOutputTokens` has an upper limit.
- It passes the abort signal through.

### The prompt

`createSummarizationPrompt` serializes the messages into **text**. It does not replay them as a real message prefix ([prompt.ts](./prompt.ts#L234-L282)). The reasons:

- With a real prefix, the model tends to continue the conversation instead of summarizing it.
- Provider prefix caching is not reliable on the OpenAI-compatible endpoints that this application uses.

The structure:

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

<fixed structured summary instruction>
```

The summary format is fixed: `Goal` / `Constraints & Preferences` / `Progress (Done, In Progress, Blocked)` / `Key Decisions` / `Next Steps` / `Critical Context` / `Files and Code`. It also requires exact paths, function names, commands, error messages, identifiers, and numbers.

The rendering rules:

- It skips a `system` message.
- It discards `reasoning`.
- It truncates a tool result to 2000 characters by default, and to 280 when the budget is exceeded.
- It renders a file attachment as a placeholder. It discards an image and a reasoning file.
- It keeps one marker line for an approval request and its result.

### The budget of the summary itself

```text
maxPromptTokens = max(512, window - maxSummaryTokens - 2000)
maxOutputTokens = window
  ? min(maxSummaryTokens, max(512, floor(window / 8)))
  : maxSummaryTokens
```

If the prompt exceeds the budget:

1. First, lower the payload limit from 2000 to 280.
2. If it still exceeds the budget, drop about 10 percent from the oldest message at a time, until the prompt fits or one message remains.

`previousSummary` always stays in `<previous-checkpoint>`. A repeated compaction can therefore merge the old checkpoint with the new region instead of losing the old summary.

### The quality gate

`compactHistory` validates the summary output strictly ([compact.ts](./compact.ts#L45-L144)):

1. The summary is not empty.
2. `finishReason` is not `length`, because a truncated checkpoint is not usable.
3. It is not `error` / `content-filter`.
4. The estimated tokens of the checkpoint are below 90 percent of the replaced content (`MIN_SHRINK_RATIO = 0.9`).

If one check fails, the code throws a `CompactionError` and the caller does not write to the store.

The record fields:

- `tokensBefore`: the measurement of the whole projected history with the usage anchor.
- `tokensAfter`: the estimate of the checkpoint plus the retained segment after the region.
- `shadowedTurns` / `shadowedSteps`: the count of the turns and the steps in the region, from the projection anchors.

## Manual compaction

### Entry

The server exposes `POST /sessions/{sessionId}/compact`, with the input `{ sessionId, model }` ([session.router.ts](../../../server/src/routers/session/session.router.ts)). It returns `{ activeStreamId }`, and the compaction itself runs in the background. The client then reads the events from `GET /sessions/{sessionId}/stream`.

The preconditions:

- The session exists.
- No stream runs, and `activeStreamId` is empty.
- No tool call waits for an approval.
- No `tool-call` is unanswered.

When a precondition fails, the route returns `SESSION_BUSY`. When there is nothing to compact, it returns `NOTHING_TO_COMPACT`. Both tests run before the stream exists, so the caller does not need a stream id and a failure event. A summary failure occurs inside the stream: `compaction.error` withdraws the marker and the history stays as it was.

### The selection

`planManualCompaction` selects the cut point at **turn granularity** ([select.ts](./select.ts#L85-L190)):

- It counts from the newest turn to the front until it reaches `keepRecentTokens`, and the cut point falls on the start of that turn.
- It **never summarizes the newest user request**. When the cut point would fall after the newest user turn, it moves back to that user turn.
- The retained segment plus the maximum summary still exceeds the threshold → it degrades to `full`, with an empty retained segment.
- The region is below `minSummarizeTokens` → it returns `undefined` when the threshold is not exceeded, and `full` when it is.
- The branch is empty and no head can hold the marker → `full` when the threshold is exceeded.

### Linear append and the cut point

| Mode     | `retainedFromTurnId`    | Branch topology                                                                  |
| -------- | ----------------------- | -------------------------------------------------------------------------------- |
| `recent` | The first retained turn | The parent of the new turn C is the old head, and `activeHeadId` points to C.    |
| `full`   | Absent                  | The same as `recent`. The checkpoint replaces all the content before the marker. |

[`saveTurn`](../../../server/src/storage/sqlite-store.ts#L306-L355) (`head: true`) only appends:

```text
insert C (parent = old head)
session.activeHeadId = C
```

The cut point of `recent` is no longer expressed by a rewrite of the `parentId` of the retained segment. The code writes it into `CompactionRecord.retainedFromTurnId`. When the projection reads the last manual marker with a cut point, it puts the checkpoint first, rebuilds the retained segment from that turn, and skips this marker and the earlier markers that it covers. The local transcript, which only appends at the end, is therefore always a prefix of the branch. The summary call occurs before the write to the store, so a failure leaves no marker.

### The stream of a manual compaction

A manual compaction and a normal turn share the `Agent.stream` entry point. Only the `signal` differs:

```ts
// a normal turn
await agent.stream({ turns, modelId, signal: { type: "turn" }, onFinish });

// a manual compaction
await agent.stream({
  turns,
  modelId,
  signal: { type: "compaction", trigger: "manual" },
  onFinish,
});
```

`Agent` completes the projection and `planManualCompaction` before the stream exists, so `NOTHING_TO_COMPACT` is still a synchronous error. The background work then writes the events in the order of a normal turn: `turn.start` (`turnType: "compaction"`) → `step.start` → `compaction.start` → the summary → `compaction.end` → `step.finish` → `turn.finish`. It then writes the turn into the branch, and only then closes the stream and lets `onFinish` settle the session row. When the reader reaches the end, the branch and `activeStreamId` are already consistent.

The client only reads the stream. The compaction turn appends linearly, so the transcript that the local assembler builds agrees with the branch, and the client no longer replaces its local turns with `listSessionTurns` after the stream ends ([session.tsx](../../../ui/src/blocks/session.tsx)). The interface no longer stores a separate compaction state. A compaction in progress is the streaming compaction part in the transcript, and a summary record or a `compaction.error` reports the success or the failure.

### The `/compact` command

The interface parses `/compact` before it submits the input, and it accepts no extra text. After the POST returns, the client joins the stream of that session at once. A streaming compaction part in the transcript means a compaction is running. On success a summary record shows the token counts before and after, and on failure `compaction.error` reports the failure. An automatic compaction that fails still only writes a log line and does not disturb the user. The context ring prefers `tokensAfter` of the latest compaction over the usage before the compaction.

## Concurrency and persistence

A manual compaction and the act of sending a message or starting a turn compete for the same branch. A compaction is now a background stream, and it continues after the preparation step returns. The serialization here therefore uses only a claim marker and a transaction:

| Layer      | Mechanism                            | What it prevents                                                                      |
| ---------- | ------------------------------------ | ------------------------------------------------------------------------------------- |
| Turn claim | `activeStreamId` + `STREAM_REGISTRY` | A compaction that enters a running turn, and a turn that enters a running compaction. |
| Store      | The transaction of `saveTurn`        | A partial write of the insert, the reparent, or the head.                             |

The preparation step tests the claim at its start. `createSession` returns `SESSION_BUSY` when the same session still has an open stream, and a manual compaction does the same. An entry that ended but is not yet removed from the registry does not count as a claim, so an approval resume cannot hit a cleanup race. There is no mutex between the test and the stream registration: when two calls enter the same session at the same time, both pass the test, and the later writer overwrites `activeStreamId`.

## Module map

| File                             | Responsibility                                                           | Side effect                                   |
| -------------------------------- | ------------------------------------------------------------------------ | --------------------------------------------- |
| [types.ts](./types.ts)           | The records, the policy, the projection structures, `SummarizeFn`        | No                                            |
| [policy.ts](./policy.ts)         | The resolution of the threshold and the retained budget, `shouldCompact` | No                                            |
| [estimate.ts](./estimate.ts)     | The single token estimate rule                                           | No                                            |
| [prune.ts](./prune.ts)           | The model-independent pruning of tool results                            | No                                            |
| [prompt.ts](./prompt.ts)         | The checkpoint framing and the summary prompt                            | No                                            |
| [summarizer.ts](./summarizer.ts) | The default summary call (`generateText`)                                | Yes (a model call)                            |
| [project.ts](./project.ts)       | Turns to model messages and anchors                                      | No (it only converts)                         |
| [select.ts](./select.ts)         | The placements, the manual planner, and the context measurement          | No                                            |
| [compact.ts](./compact.ts)       | The summary, the validation, and the record                              | Yes (through the injected summarize function) |
| [marker.ts](./marker.ts)         | The construction of a compaction step and turn                           | No                                            |
| [overflow.ts](./overflow.ts)     | The recognition of a provider context overflow error                     | No                                            |
| [index.ts](./index.ts)           | The public exports                                                       | No                                            |

A suggested reading order:

```text
types → policy / estimate → project → select → compact → prompt / summarizer
      → marker → overflow → #maybeCompact in agents.ts → compactSession in the server
```

## Tests

The unit tests are in `packages/agent/tests/compaction/`, and the event assembly tests are in `packages/agent-client/tests/compaction.test.ts`.

```bash
vp test packages/agent/tests/compaction packages/agent-client/tests/compaction.test.ts --run
```

The coverage:

- The threshold, the retained budget, and the disabled reasons of the policy.
- The per-part rule of the estimate.
- The trimming, the tail protection, and the idempotence of the prune.
- The reset, the last-marker-wins rule, the usage anchor, and the tool pair of the projection.
- The pre-turn placement and the manual `recent`, `full`, and nothing-to-do cases of the selection.
- The empty summary, the truncation, the missing shrink, the abort, and the empty interval of the compaction.
- The framing and the budget degradation of the prompt.
- The construction of the marker.
- The assembly and the withdrawal of `compaction.start` / `compaction.end` / `compaction.error` in `AgentTurnAssembler`.
- The `compaction` signal of `Agent.stream`: the store position of the separate turn, the synchronous failure when there is no content, and the withdrawal after an abort ([stream-compaction.test.ts](../../tests/stream-compaction.test.ts)).

A test injects `SummarizeFn` to avoid a dependency on a provider.

## Trade-offs and known limits

- **The saving of the pruning does not appear in the pressure measurement at once.** With a usage anchor, `measureContext` uses `inputTokens` of the last request plus the estimate of the messages after the anchor. An old tool result usually sits before the anchor, so the pruning changes the message content but not this number. The saving of the pruning therefore appears only when the next real call reports a new usage, and one more summary can occur in between.
- **An overflow compacts and does not retry.** The route returns an error after the compaction, and the caller sends the request again.
- **An over-budget summary prompt drops the oldest messages.** On the first compaction of a very large region, the oldest content can stay out of the summary and have no previous checkpoint as a fallback. This keeps the summary call itself inside the window.
- **The shadowed counts of a mid-turn compaction can be too small.** `compactHistory` uses the projection anchors from the start of the turn. The steps of the current assistant turn are not in the anchors yet, so `shadowedTurns` / `shadowedSteps` count too few. This affects only the audit counts, not the result of the compaction.
- **`record.tokensAfter` does not include the system prompt and the tool schema cost.** The interface shows the message-only figure. The next pressure measurement adds the overhead when there is no usage anchor, so the two values differ a little.
- **The before-turn path switches the in-memory state first and writes the previous assistant turn after.** If `store.updateTurn` fails, the catch block only writes a log line and does not roll back the in-memory state. The model sees the compacted history in this turn, and a reload returns to the uncompacted history. The write of a dirty step at the end of the turn usually completes this persistence.
- **Automatic pressure compaction runs at most 3 times per turn.** The overflow case is not subject to this limit.
- **With `auto: false` the pressure path does not run at all, including the pruning.** On the automatic path only an overflow still tries a compaction, and a manual compaction is not affected.
- **A manual compaction is a background stream, and it does not resume.** A closed page does not interrupt it, as with a normal turn. A `stop` or the end of the process aborts the summary. The abort goes through `compaction.error`, and the history does not change.
- **The claim test of `activeStreamId` is not atomic.** There is no lock between the test and the write to the store, so multiple processes or instances that share one SQLite file get no cross-process mutual exclusion.
