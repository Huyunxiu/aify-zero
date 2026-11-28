# A session ledger

One session keeps one append-only file of records. A replay reads that file. The file
does not replace the transcript, and the database does not hold it.

The reason is one question that the transcript cannot answer today: what did the model
see and under what rules did it act. Three facts decide the answer, and none of them is
stored:

- the model route is decided for each turn, and a `turn_start` hook can move it;
- the approval policy is read once for each run, and only its current value is stored;
- the assembled system prompt is not stored at all.

A ledger records those facts beside the events that produced them. Then a defect that
happened at 03:00 is readable at 10:00.

## Goal

Reproduce a defect: every step's input, output, and effective settings are present, and a
crash does not erase them. A timeline in the session panel is a free consequence, not a
separate goal. Audit and evaluation fixtures are out of scope.

## Where it lives

```
<dataDir>/sessions/<sessionId>/ledger.jsonl            the records
<dataDir>/sessions/<sessionId>/ledger/blobs/<sha256>   a system prompt, by digest
```

The session directory already holds `attachments/`. A ledger sits beside it.

A subagent session has its own ledger, because a subagent is a session. The parent names
the child through `tool.result.metadata.sessionId`. No record repeats that name.

## The line

One JSON object on one line. Five fields come first.

| Field   | Type           | Job                                                                                                           |
| ------- | -------------- | ------------------------------------------------------------------------------------------------------------- |
| `line`  | number         | Address of the record. Starts at 1 and never resets. Also proves that no line is missing.                     |
| `v`     | `1`            | Format version of this line. A reader parses by it. It is a constant type, so a wrong value does not compile. |
| `at`    | number         | Write time, epoch milliseconds. The wall-clock axis of a replay.                                              |
| `epoch` | string \| null | The channel instance. A reader that starts in the middle needs it.                                            |
| `type`  | string         | The record name. The first dot splits the family.                                                             |

Two fields were removed from an earlier draft, and the reasons hold:

- `kind` repeated what `type` already says. Two descriptions of one fact drift apart.
- `seq` had no reader. Paging uses `line`, and the live path does not read the ledger. Add
  it later if a replay must continue from a live cursor. An added field does not need a
  new version.

`at` and an event's own `createdAt` can differ. Ordering and the wall-clock axis use `at`.
The meaning of an event uses its `createdAt`. Neither overwrites the other.

## Two families

The family decides the reader's path. The full `type` decides what to do with the record.

**`stream.*`** is the process on the screen. A replay rebuilds the panel from these.

**`note.*`** is a fact the screen never showed. A replay draws these as annotations.

`stream.*` has 3 members and does not grow. `note.*` has 9 and grows.

## The records

### `stream.run.start`

`streamId`, and `turnIds` / `turns` when the run claimed inbox items.

It is the only place where a user turn's body enters the ledger. A user turn holds no
step, so `note.step.settled` does not cover it.

### `stream.run.event`

`streamId` and `event`, the `AgentStreamEvent` unchanged. 27 of the 30 types are recorded.
The three that are not are `text.delta`, `reasoning.delta`, and `tool.input-delta`.

### `stream.run.end`

`streamId`, and `failure` when the run failed. An absent line here is evidence of a
crash, and a value that can be derived cannot serve as evidence.

### `note.process`

`pid` and `appVersion`. The `epoch` field already shows that the process changed, so this
record holds the identity of that process and nothing else.

### `note.inbox.arrived`

`inboxItemId`, `inboxKind`, `dedupeKey`, `deliverAt`. The kind is imported from
`InboxItemKind`; it is not copied into the ledger. Nothing else records an item before a
run claims it.

### `note.inbox.claimed`

`inboxItemId` and `turnId`. Only a user message has a `dedupeKey` that equals its turn id.
A notice and a timer do not, so the link cannot be derived.

### `note.inbox.discarded`

`inboxItemId` and `reason`. An absent claim is not a cancellation: a queued item and a
discarded item look the same from every other record.

### `note.turn.settings`

`turnId`, `streamId`, `model`, `effort`, `approvalPolicy`, `instructions`, and `sections`.
It is written for a turn that calls the model, and for no other turn.

`instructions` is `{sha256, bytes}`. The text is in `blobs/`. `sections` is
`{id, priority, sha256}[]`, so a reader can say which blocks built the prompt.

The four facts travel with each turn instead of appearing as change events. A change point
follows from two adjacent settings. The reverse does not hold: one missed change event
makes every later turn wrong.

### `note.turn.superseded`

`turnId` and `supersededByTurnId`. A regenerated turn keeps its old records.

A turn id can appear under two streams for two reasons: the user regenerated the answer,
or the run continued after an approval. The two mean opposite things, and only a record
separates them.

### `note.step.settled`

`turnId`, `stepId`, and `content`, the whole `AgentStep`. It is written when the step
settles and again when its metadata arrives, so one `stepId` can appear more than once. A
reader takes the last one.

It repeats what the database holds. That is deliberate: a regeneration overwrites the row,
and the old attempt must stay in the ledger.

### `note.step.delta-backlog`

`turnId`, `stepId`, `truncated`, and `chunks`. It appears only on a step that failed or
was interrupted. The buffer of deltas is flushed at the moment of failure, so this record
can come after the `stream.run.event` that reports the failure.

### `note.recovery`

`turnId` and `reason`. It separates a model error from an error that the process
substituted after a crash.

## Writing

The ledger is written first, and the step settles after it.

```text
onStreamEvent(streamId, event)
  if event is a delta
    buffer[event.stepId].push(event)          // memory only, capped at 256 KiB
    return
  append({type: "stream.run.event", streamId, event})
  if event is step.finish and event.status is "error"
    append({type: "note.step.delta-backlog", ...buffer[event.stepId]})
    drop(buffer[event.stepId])

append(payload)
  line = next line number
  write({line, v: 1, at: now(), epoch: currentEpoch, ...payload})
  on failure: count it, warn, and continue     // a run never fails because of the ledger
```

`write()` returns when the bytes reach the file, so a process crash loses nothing. `fsync`
runs at each step boundary, so a power loss loses at most the current step.

A last line can be truncated. A reader drops it.

## Reading

One read-only route: `GET /sessions/{id}/ledger?from=<line>&limit=<n>`. The replay view
reads it in the browser and projects it. The server adds no second concept.

The projection runs in two passes, and the order matters, because content can arrive
after the events that describe it.

```text
pass 1: build the structure
  for each stream record
    run.start      → start an attempt
    run.event      → turn.start, step.start, step.finish, turn.finish give order and status
    run.end        → close the attempt
pass 2: put the content on it
  for each note.step.settled
    settled[stepId] = content                   // the last one wins
```

Structure comes from `stream.run.event`. Content comes from `note.step.settled`. Both are
needed, and neither can replace the other.

Ordinary browsing still reads `turn` and `step`. A broken ledger does not break browsing,
and a wrong row cannot corrupt a replay.

## Changing a record later

Additive change is free. A new field, a new part type, a new `note.*` member, and a new
`AgentStreamEvent` all parse with the readers that exist.

Three rules make that true:

1. **Unknown means opaque.** A reader skips an unknown family, keeps an unknown member
   unchanged, and never throws. Without this rule, one new event type breaks the replay of
   every old session.
2. **The delta filter is a list of what to skip, kept in one place.** A new delta-like
   event that nobody adds to that list costs the disk.
3. **A new effective setting raises `v`.** It does not rewrite old lines, because `v` is on
   each line. A reader that finds `v: 1` shows "this record has no such field". A default
   value would lie about the past.

A change to what a turn or a step _means_ is not additive. An old record then shows as it
was and is not interpreted by the new rules. The ledger keeps what happened, not what it
means.

## Sensitive text

A record is written as it is. The machine is the user's own. Redaction belongs to the exit:
an export or a report removes what must not leave the machine. That work waits for a
requirement.

## Out of scope

An export route, redaction, a revived tape, a new session from a ledger, a retention
period, and any move of the ledger into the database.

## Tests

Two seams.

- **The file boundary.** Append records, read them back, get the same records. A truncated
  last line is dropped, and a broken line in the middle is skipped and counted.
- **The replay of a run.** Record one run through `fake-provider`, project it, and get the
  same timeline that the live path showed. This is the only measure that decides whether
  the feature works.
