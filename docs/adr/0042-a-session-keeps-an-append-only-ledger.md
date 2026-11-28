# A session keeps an append-only ledger

A defect that happened last night cannot be read this morning. Three facts decide why the
model did what it did, and none of them survives the run:

- The model route is decided for each turn. A `turn_start` hook can move it, and the turn
  row holds no field for it.
- The approval policy is read once for each run. Only the session's current value is
  stored, so one change makes every earlier turn unreadable.
- The assembled system prompt is not stored at all. The `turn` and `step` tables have no
  instructions column, and `bot.instructions` is the static text, not the assembly.

The transcript is also lossy in a way that hides itself. The write path is an upsert of the
latest state: a `streaming` turn is inserted, `step.finish` upserts a step row only when the
step did not fail, and every delta is dropped. A crash leaves the in-flight step with
nothing, and recovery marks the turn `error` with one flat reason. A regeneration overwrites
the row, so an earlier answer leaves no trace.

The event channel does not help either. It holds one run in memory, clears its buffer at
each `turn.start`, and replays a finished run from the database instead. The stream is a
screen, not a record.

So one session keeps one append-only file of records beside the session directory. The
transcript stays the view and the ledger becomes the evidence. A replay reads the ledger and
never reruns the model, because the model is not deterministic and a tool's effects cannot
be repeated.

## Considered Options

- **An `event` table in SQLite, with the transcript as its projection**: the textbook shape,
  and queryable. It puts a write on the hot path of every event, needs a migration, and
  raises the one question this feature cannot answer yet: what happens when the projection
  and the log disagree.
- **Make `step` append-only with a `superseded_by` column**: the smallest change. It stays
  at step granularity, so a delta, an approval, an inbox cause, and an effective setting
  never fit, and the two facts that matter most are exactly those.
- **Revive the unmerged `aify0-89` tape**: a versioned JSONL recorder at the provider HTTP
  layer, already written. It records what the model received, which is not what the human
  did: a claim, a steering sentence, an approval, and a compaction are invisible there. It
  stays a test tool.
- **Reference the transcript instead of copying content**: the smallest file. A regeneration
  overwrites the row, so an earlier attempt keeps only an id. This fails the one requirement
  the feature exists for.
- **A JSONL file beside the session** (this decision): no migration, no hot-path change to
  the transcript, and one append that a failure cannot propagate to a run. It costs a second
  copy of the step content and a format that must stay readable for years.

## Consequences

- The step content lives in two places, and the ledger's copy is roughly a second copy of
  the bytes. The duplicate is the price of keeping an overwritten attempt.
- The ledger holds what happened and not what it means. A record whose meaning changed shows
  as it was and is not reinterpreted, so a replay of an old session can be faithful and
  still be useless.
- Deltas of a failed step live in memory until the step fails. A process that is killed
  keeps the failure point and loses the typing inside it.
- The ledger never repairs the transcript and the transcript never repairs the ledger. A
  reader that needs both facts says which one it read.
- A new effective setting raises the line version. Old lines keep their version and show
  "this record has no such field", because a default value would describe a past that never
  happened.
- The read path is one route over a file, so the replay view can be built and thrown away
  without a schema change. That is what makes the decision reversible: delete the files and
  the history is gone, but the product never depended on it.
