# The system prompt has one writer

`turn_start` and `step_start` patches could carry `instructions`, and the merge replaced the
whole string. The system prompt is assembled from instructions sections when the turn starts:
the environment, the project instructions, the skills catalogue, the subagent catalogue, and
the cross-cutting rules. A plugin that returned `instructions` deleted all of it for every step
and said nothing. `title.ts` already showed the seam: it read the patch and dropped
`instructions`, so the same hook behaved differently at each call site.

Two writers for one string is the defect, not a missing rule. A section already expresses
order, condition, and composition, and a subagent can read its own text. A patch has nothing to
add that a section cannot say.

A patch now carries only what one call needs at that moment: the model. A field that is not on
the patchable list is ignored, so a plugin written in JavaScript cannot reach the prompt either.

## Considered Options

- **Keep replace and document it.** The cost of a mistake is a prompt with no environment and no
  project instructions, and the model cannot report it.
- **Append-only patches.** A second append mechanism beside sections, with its own ordering
  question and its own test.
- **One writer (chosen).** Sections write the prompt; patches change the call.

## Consequences

- A plugin that changes the prompt registers an instructions section. It can set an id, a
  priority, and a subagent variant, which the patch path never offered.
- `RuntimeSettings` keeps `instructions` for the request, but `RuntimeSettingsPatch` no longer
  has the field, and the merge filters unknown keys.
- A test that proved a patch does not persist to the next turn now proves that a patch cannot
  apply at all.
