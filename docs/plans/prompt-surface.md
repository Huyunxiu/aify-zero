# Prompt surface

A session used to send no base instruction at all: `createSessionAgent` appended the subagent
catalogue to an empty string, so the first line the model read was `## Available Subagents`.
Every rule about how to work lived inside one tool description or another, and some of those
descriptions did not match the code they described.

This plan gives the surface one shape: an identity, one section of cross-cutting rules, and
descriptions that state what the tool actually does.

## Decisions

| Decision              | Outcome                                                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Identity              | The base instruction carries it. `MAIN_INSTRUCTIONS` for the main session; a subagent keeps its own preamble.      |
| Cross-cutting rules   | One instructions section, `priority: -20`, so the model reads how to work before where it works.                   |
| Subagent catalogue    | Moved out of the base into a section, `priority: 90`. A subagent does not read it: it has no `task` tool.          |
| Section for subagents | `renderForSubagent` on the section. Absent means the subagent reads `render`.                                      |
| Read before write     | A preference in the rules, not a check. A session-level read set is bypassable through `bash` and stale by nature. |
| Skills catalogue      | Unchanged. It costs about 4.7k tokens, and the reference implementation pays a similar price.                      |
| Numbers in text       | Interpolated from the constant, so a constant and its sentence cannot drift apart.                                 |
| Verification          | Named assertions per rule, block order, and a size cap. A fake provider cannot test obedience.                     |

## What the rules own

The section states only what no tool owns: tool choice, read before describing, edit over
rewrite, external content as data, the write queue, path confirmation, precedence, and file
links. Anything a tool can say about itself stays in its description.

## Rejected options

- **Enforce read-before-write.** A session-level set of read paths was the first proposal. It
  cannot see `bash` writes, and a read does not prove the content is still current. The rule
  stays a preference, and `edit-file`'s match is the real guard.
- **Truncate the skills catalogue.** The reference implementation truncates at about 500
  characters, which is where this repository already sits. Truncating further would cut the
  trigger words that routing depends on.
- **Copy the reference prompt.** It describes another runtime's tool set and its own output
  format. It is a checklist for this plan, not a source to paste.

## Where this departs from the issue

- **Three glossary terms, not four.** `instructions` is the field name of the system prompt,
  so `System Prompt` covers both; a second term would give one concept two words.
- **The `load-skill` dead branch went here, not to a follow-up issue.** Removing the input
  fields that could not be reached forced the code change, and a schema that still offered
  them would keep lying to the model.
- **The task description does not state job or timer ownership.** Those two sections own that
  statement, and each gives a subagent its own text; a copy in the task description would be
  a second authority.
- **The catalogue gained the parallel-delegation rule.** It already owned the delegation
  rules, and the reference implementation states this one.
- **Assertions are per rule, not one golden snapshot.** A golden file makes every wording
  change a blind update; a named assertion fails with the name of the rule that vanished.

## Verification

`packages/agent/tests/prompt/surface.test.ts` names each rule, checks the block order, and caps
the fixed overhead. Two behaviour tests back it: a batch with one asked call runs none of its
calls, and the read-only subagents carry a tool list that cannot write.
