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
model stream, so it holds no slot.

## A repeated call appends instead of discarding

The call was already idempotent by tool call id: the same call re-run found its child session
and carried on from that transcript. It also threw away the new brief, because a retried call
was assumed to carry the same brief.

Now that a message can be delivered on purpose, one path is enough. A repeated call appends
its brief to the same subagent, exactly as a message does. Two paths to one transcript would
have drifted, and the discarding one would have kept a silent bug.

## A background unit that never settles is silent

A synchronous call that hangs is visible: the Assistant is stuck inside it. A background
subagent that hangs is invisible — nothing is blocked, the session simply goes quiet.

So every subagent run has a wall clock limit, generous by default, and the limit settles the
run and sends the notice. The service also settles the runs of a previous process at start and
sends their notices, which the recovery path already did for sessions in general but not for
the people waiting on them.

## The notice reports facts, not instructions

A completion notice carries the name, the type, the terminal status, and the report. It names
no tool. A job notice names one because its payload is a pointer to output too large to inline;
a subagent notice carries the answer itself, so there is nothing to fetch.

A notice is not a job's notice with another sender. The producer names the
kind it is filed under and the step source its turn carries, together, so a
settlement cannot arrive filed as a background job: the parent reads it as a
subagent's, in the transcript and in the inbox alike.

The one sentence that belongs to every delegation — do not poll, end the turn — lives in the
subagent catalogue with the rest of the guidance. A rule stated in each notice would be a
second copy of a rule that already has a home.

## A message queues; it does not interrupt

A steering word reaches a live turn only through the runner, which owns that
turn. The delegation layer holds the name and the record, not the turn, so a
message to a running subagent queues and becomes its next turn. The tool says
`queued` or `started` rather than claiming to have steered anything.

The same reason decides how an idle subagent starts: this layer builds its turns
and starts the run itself, instead of writing an inbox item that only the main
session path can claim. A subagent session is still refused by the runner's
inbox entry, and opening that door is a separate decision.

Withdraw has no counterpart here. A job notice withdraws itself when the model
reads the output first; a subagent notice carries the answer, so nothing
consumes it out of band and there is nothing to withdraw.
