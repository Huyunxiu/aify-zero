# A subagent can be messaged again

A subagent was a synchronous leaf. The delegating Assistant made one tool call, the call did
not return until the subagent ended, and the subagent's Agent was disposed when its stream
ended. A second message to it was impossible: a child session refused every run that did not
come from the call that made it.

That one shape caused three separate complaints. The Assistant could do nothing while a
subagent worked, so several delegations in one message still cost the sum of their runtimes. A
half-finished result could not be questioned without starting over from a brief, and the new
subagent had read nothing. A runaway subagent could not be stopped, because the Assistant was
blocked inside the very call that would have stopped it.

Delegation now starts a run and returns. The call answers with a name, the subagent settles
into a completion notice, and three more tools reach it while it runs or after it reports.

## The call no longer waits

A subagent's lifetime is now the parent session's lifetime, not the parent turn's. It stops
when the parent session is stopped or archived, and it survives the end of the turn that
started it. The first version tied it to the parent turn because that turn was the only thing
holding the child's abort scope; keeping that tie would have killed every subagent at the end
of the turn that made it, which is exactly what background delegation must not do.

## Capacity rejects instead of queueing

A session may have a fixed number of subagents running. A delegation over that number is
refused with a sentence the model can act on: wait for one to finish, or stop one.

A queue was rejected. Waiting for capacity deadlocks the moment every slot belongs to an
Assistant that is itself waiting for a subagent, and nothing in this runtime can tell that
state apart from ordinary slowness. A refusal is recoverable in one step; a deadlock is not.

Only running subagents count. A subagent that reported and is waiting for a message holds no
model stream, so it holds no slot. The limit is 8, and `AIFY_SUBAGENT_LIMIT` sets it at start.

The count and the start it guards are one step. Counting the running subagents and registering
the new one are several awaits apart, so two delegations that arrive together would count the
same number and both start — the limit would be a hint, not a limit. One lock carries every
decision about a session's subagents: a start, a settlement that opens the next turn, and a
stop. It is keyed by the parent session, not by the object that holds the tools, because that
object is built once per parent run and a child outlives it: the settlement arrives in a later
run's copy.

A settlement that opens the next turn needs no check of its own. It gives up its slot and takes
the next one in the same locked step, so the count it sees is the one it leaves behind.

A check in the database was rejected. The count lives in the process's stream registry, not in a
column, so a row constraint would count a different thing — and the process that can see the
truth is the one that has to serialize.

## A repeated call appends instead of discarding

The call was already idempotent by tool call id: the same call re-run found its child session
and carried on from that transcript. It also threw away the new brief, because a retried call
was assumed to carry the same brief.

Now that a message can be delivered on purpose, one path is enough. A repeated call appends
its brief to the same subagent, exactly as a message does. Two paths to one transcript would
have drifted, and the discarding one would have kept a silent bug.

What the brief does depends on the child, and the child decides it, not the call. Against a
running child the brief becomes an inbox item that the child reads at its next step; it starts
nothing and takes no slot, because it adds no run. Against a child that has stopped it does
start a run, so it counts, and it can be refused for capacity like any other start.

## A background unit that never settles is silent

A synchronous call that hangs is visible: the Assistant is stuck inside it. A background
subagent that hangs is invisible — nothing is blocked, the session simply goes quiet.

So every subagent run has a wall clock limit, one hour by default, and the limit settles the
run and sends the notice. `AIFY_SUBAGENT_TIMEOUT_MS` sets it at start, next to the capacity
knob, because neither has a settings surface yet. The service also settles the runs of a
previous process at start and sends their notices, which the recovery path already did for
sessions in general but not for the people waiting on them.

## The notice reports facts, not instructions

A completion notice carries the name, the type, the terminal status, and the report. It names
no tool. A job notice names one because its payload is a pointer to output too large to inline;
a subagent notice carries the answer itself, so there is nothing to fetch.

A notice is not a job's notice with another sender. The producer names the
kind it is filed under and the step source its turn carries, together, so a
settlement cannot arrive filed as a background job: the parent reads it as a
subagent's, in the transcript and in the inbox alike.

The writer is a capability, not a port. It began as an object the server built
and bound to the runner after construction, which meant the layer that settles
work had to be told about the runner by the layer above it. The runner now
builds the one writer and hands the same object into every assembly, so an
extension reaches its session the same way it reaches storage — and a subagent
is deliberately not given one, because it reports through its transcript.

The one sentence that belongs to every delegation — do not poll, end the turn — lives in the
subagent catalogue with the rest of the guidance. A rule stated in each notice would be a
second copy of a rule that already has a home.

## A handed-over sentence waits as an inbox item

What a parent hands to a subagent waits in that subagent's inbox, as an inbox
item, because the row outlives the call that wrote it: a subagent can finish, be
stopped, or lose its process, and the item still carries the sentence to the run
that reads it next.

The arrival boundary decides what the sentence becomes. A live turn takes it at
its next step boundary, and it lands as Steering inside that turn; anything else
waits for the next run, which claims it in the transaction that writes its turns.
That rule is the inbox's (`resolveDeliverAt`), not a copy kept here.

Only one run claims at a time. The parent can hand a sentence over at the moment
the previous run ends, and the settlement of that run also looks for what is
waiting, so both paths pass through the lock described below.

A run that ends on its own terms opens the next one for items it could not take,
so a parent never has to send the same sentence twice. A canceled or failed run
does not: nothing will start that child again. Its settlement notice throws away
the items it never read and says how many. `wait_review` is the exception, since
that run is parked rather than over.

Stopping a subagent throws its waiting items away too, and `stop-agent` reports
the count, because the turn that would have read them is the one being stopped. A
parent session's stop leaves them alone: if that session runs again and messages
the child, the older sentences arrive in order ahead of the new one.

A restart delivers nothing by itself. The items wait until the parent runs that
child again, and then they are read ahead of the new sentence. Booting does not
wake a subagent's session, so nothing runs it in the meantime.

A settlement is one notice per run, not one per child: a child can settle twice,
and the second notice must not be dropped as a duplicate of an unread first one.

One promise this row cannot make is exactness under a retry. A call that runs
again after its item was claimed writes a second item, so one sentence can be
read twice. It cannot be lost the other way: the claim is part of the transaction
that writes the turn.

The row records a model, which its shape requires and a subagent's session row
does not carry. `send-message` records the one the child would run with. A run
resolves the model the same way, so the copy only differs when the parent moves to
another model in between — and then the run is right.

A subagent session is still refused by the runner's inbox entry, and boot no
longer wakes one. Its next run is opened by the tool call that holds its name, so
a wake-up would report a run that never happens.

## A session remembers the payload it last ran with

The notice a crash leaves for a parent is written by the next process, which has
never run that session. A wake-up run needs a payload, and the only copy lived in
memory, so the notice was written into nothing: waking the session found an empty
inbox, the run never started, and the send gave up after a timeout.

So a run writes its payload onto the session row, and the recovery path hands
that snapshot to the writer — the same shape a timer carries for the same reason.
A session with none is skipped with a warning: it has not run since this column
existed, so there is nothing to wake it with and nothing to tell it.

The notice also reports what the child had already said, and the status it
settled as. A crash does not make every run a failure: one that had answered and
only failed to clear its marker settles as done. An empty answer still settles as
an error, which is the rule a live settlement already uses.

One case stays blind: a stored model that is no longer configured. The write
succeeds and the wake-up run fails, which the runner logs and pauses; the notice
waits in the inbox and the next boot drops it as stale. Detecting that here would
mean reading the model configuration in the boot path, which this process does
not do.

Withdraw has no counterpart here. A job notice withdraws itself when the model
reads the output first; a subagent notice carries the answer, so nothing
consumes it out of band and there is nothing to withdraw.
