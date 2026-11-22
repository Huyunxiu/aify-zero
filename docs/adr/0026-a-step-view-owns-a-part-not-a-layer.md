# A step view owns a part, not a layer

The transcript held one tool's knowledge in three places: its icon and title in
`assistant-message.tsx`, its highlight language and diff in `tool-panels.tsx`, and its
summary in `tool-step.tsx`. The first of those was a twelve-branch chain, and ten of the
branches repeated the same row, frame, and approval strip word for word.

The previous refactor (AIFY0-108) split those three files by **layer**: a row reads
something, a dialog body shows something, the message composes. That put each rule in one
file, and split each subject across three. This decision keeps the layer modules as shared
primitives and makes the **step view** the authority: one module per part, holding what its
row says, what its body shows, and what its summary reads.

Four rules:

- **One table, keyed by the part's `type`, exhaustive over the protocol.** The table is a
  `Record`, not a `Partial`, and `dynamic-tool` has an entry of its own. A part type added
  to the protocol fails to compile until it has a view. `custom` and `session.title` have
  views that render nothing: silence is a decision, not an omission.
- **A view is a component, not a descriptor.** `task` draws a row that selects the pane
  beside the transcript instead of opening a dialog; `questionnaire` draws a form outside
  its own step. A data record for these grows callbacks until it is a badly typed
  component.
- **The shell owns a row; a view owns its wording.** `steps/shell.tsx` draws the trigger,
  the row, the frame header, and the approval strip. A view supplies the icon, the label,
  the summary, and the body, and takes the whole row back only for the two exceptions
  above.
- **The protocol reads stay put.** `tool-step.tsx` keeps what the record itself answers —
  state, error wording, timing, the turn's count — because those are judgments about a
  part's shape, not about one tool. The wording that depends on a tool's `metadata` lives
  in that tool's view.

## Considered Options

- **A descriptor table** (icon, title, summary, body as data): uniform, and it fits the
  parts that are only text. It does not fit `task` and `questionnaire`, whose bodies are
  different arrangements rather than different data.
- **Two tables** — tools and non-tools: each stays narrow, but a third place then decides
  which table to read. That third place is the knowledge this decision deletes.
- **Moving the JSX and keeping the chain**: the message would still hold twelve branches,
  and the subject would still be split across three files.

## Consequences

- Adding a tool to `AgentToolSet` fails to compile until its view exists.
- `tool-panels.tsx` no longer names a tool: the read-file language and the edit diff move
  to the views that know them, and the panels take the language as a prop.
- A view that needs ambient state (`task` and the subagent pane) reads it itself instead
  of receiving it from the message.
- The chain in `assistant-message.tsx` becomes a single lookup.
