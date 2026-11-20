# An approval policy becomes decisions in the composition root; the executor does not know it

A session has an approval policy: edit, read-only, or full access. The user's choice lives
in `session.approval_policy`, and every run uses it as it is, whichever run started it.
`createSessionAgent` turns the policy into a `ToolApprovalPattern`. That pattern folds with
the host rules (the MCP annotations), and the executor receives the result. The executor and
the decision layer still see three answers only: allow, ask, and deny. One place reads the
policy: the `ANSWERS` table answers "what does a policy say for a class". The executor does
not know the policy.

The policy answers by **approval class** (read, mutate, exec, interact, unknown), not by
tool name. The class table is the one list of built-in tools. An MCP tool uses the
annotations of its server; a tool without a known annotation is unknown, which is safer
than reading it as read. This table replaces `DEFAULT_TOOL_APPROVAL_TOOLS`, so one place
answers who gets asked for a built-in tool. The host's `createMcpToolApprovalPattern` still
answers for MCP tools: only the manager can read those annotations. To merge the two, that
module would need to import the manager, and the pure table would depend on a process-wide
singleton.

Five rules that must not change:

- **A refusal comes first.** When either side refuses, the call does not run, and the
  reason travels with it. Only the read-only policy refuses a class of mutation, and no
  host allow gets past it. An unknown class (for example an MCP tool whose server sets
  `autoApprove`) gets no answer from the read-only policy: we do not know what it writes,
  so we do not pretend that we do.
- **A host's allow for one call outranks the policy's ask.** The host saw the input of this
  call (a write inside the project, an allowed path). The policy answers for a class only.
  The specific answer beats the general one, so a tier that asks does not turn a call that
  the host allowed back into a question. No tier asks before a change today, so the case
  waits: the fold keeps the order for the day a tier asks again.
- **A policy closes an ask, including one from a hook.** When the user picks a class, that
  class no longer interrupts. The ask may come from a host default or from a hook; the
  policy closes both. Full access is therefore literal for every class in the table. That
  includes an MCP tool with `destructiveHint`. A refusal is the only answer that stays.
- **No policy closes a questionnaire.** A questionnaire is a call whose content is the
  question: the user's answers travel back on the approval. A policy that allowed it would
  not be quieter, it would be broken — the tool reads the approval for answers, finds none,
  and fails. So `interact` has no row, and `policyAnswer` answers it before it reads one.
- **A sub session inherits the effective policy.** A subagent row and a fork row copy the
  value of the parent or the source. Without the copy they fall back to the default, and the
  calls that the parent allowed ask again in another session.

## Considered Options

- **A bypass branch in the executor**: the smallest change, but then two places answer "may
  this run", against the "one authority for one decision" rule. Hooks and host rules would
  also have to step aside each time.
- **An environment variable for the policy** (as `AIFY_SANDBOX_ADAPTER` does): a user
  changes the policy during a session, and an environment variable cannot change a running
  process. It also leaves no record for each session.
- **One boolean for each tool** (`autoApprove`): the combinations grow with each tool, and
  it cannot answer "is a command a mutation".
- **`session.metadata`**: it saves a migration, but that column holds data that no decision
  reads. The policy takes part in decisions, so a reader would have to open it every time.
- **`auto` as a fifth policy value** (a model judges the risk): a judge is a probabilistic
  component. It may close an ask, but it must not become a row of the table, or a pure
  function table waits for a network call. The port for a judge waits for later; the plan
  is a fourth tier that hands each call to the judge, and the table stays pure.

## Consequences

- A tier leaves the picker, and the default becomes `edit`. A stored `standard` row moves
  there too, so an upgrade removes one question from the sessions that never chose.
- No run tightens the policy. A timer or a completion notice applies the tier the user chose,
  because the tier answers only how often to ask, and a cap belongs to the sandbox and to
  read-only. A timer under full access therefore applies a change with no question, and that
  is what the tier means.
- Nothing asks before `edit-file` any more, and `bash` still never asks outside read-only.
  To change that, write a separate ADR: it changes the feel for every user.
- The read-only policy refuses `bash`. That is the only new hard protection. A read tool
  never asks more often under any policy.
- A history entry still cannot say which tier ran, because the value is the session's, not
  the run's. To trace that for each run, add a field to `run.start`; the change is additive.
