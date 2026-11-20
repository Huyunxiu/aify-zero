# A refusal carries its own sentence, and the session tells the model its tier

A call that the policy refuses used to answer the model with one constant: "Tool call
execution denied." The model could not tell a refusal from a malformed call or a broken
tool, so it tried another tool. `ToolStartDecision.reason` existed, but nothing read it:
the executor wrote the constant, and the rebuilt history wrote it again.

Four rules:

- **A refusal writes down the text it gave the model.** The `output-denied` record keeps
  it in `errorText`, the field its sibling states already use for the text that took a
  result's place. The rebuild reads that field, and falls back to `approval.reason` (a
  record written before this change) and then to the constant.
- **The rebuild is a pure function of the record.** It never derives a sentence from the
  stored tier, and never stamps a time. A prefix cache compares bytes, so a history that
  says something different on the second request loses the cache from that point on.
- **`approval` stays the record of an answered question.** A refusal by the policy, a
  hook, or the host has no approval, so `approval` is optional on `output-denied`. Filling
  it would invent an `id` and an `approvedAt`, and `approved: false` would then mean both
  "a user said no" and "nobody was asked" — the one distinction this feature keeps.
- **The session says what its tier refuses.** `ApprovalPolicyExtension` adds one section
  to the prompt, naming the classes the stored tier refuses and what to do with a
  refusal. It asks `policyAnswer`, so a tier that refuses nothing adds nothing. A sub
  session re-renders the parent's sections and needs no registration of its own.

## Considered Options

- **The policy as a `pre_tool_call` hook**: one place for the rule, but a sub session runs
  no extension hooks, so every subagent and fork would bypass it (ADR 0002).
- **Hide refused tools from the declaration**: the model would have nothing to try. The
  declaration is static per registration, so this changes the tool catalog per tier, and
  the notice plus the refusal answer the same question.
- **Put the sentence in `approval.reason`**: no new field, but it records a question and
  an answer that did not happen (see the third rule).

## Consequences

- A refused call shows a `REFUSED` block with the sentence, instead of an empty OUTPUT.
- The wording of a refusal enters the prefix cache. Changing a tier mid-session changes
  the prompt, so the next request misses once.
- The reason a hook gives now reaches the model, and so does the reason a user types when
  they decline.
