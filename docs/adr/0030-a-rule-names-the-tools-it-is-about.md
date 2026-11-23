# A rule names the tools it is about

The prompt carried one list of eight rules for every agent: the main session, the general
subagent, and the two read-only subagents. The read-only ones run four tools — read-file, glob,
grep, and load-skill — so most of what they read was about something they cannot do: edit a file,
wait for a write, confirm a path before a delete, link a file for a reader who is not there.

A rule now declares the tools it speaks about, and the rules section renders the subset the agent's
tool set satisfies. `needs` is satisfied by any one of them: one tool is enough to act on the rule.
A rule without `needs` holds everywhere. One rule is
`userFacing`: it is about talking to the person, and a subagent reports to a model, so no subagent
reads it. The exploration prompt keeps three of the eight rules and the general subagent keeps
seven.

## Considered Options

- **One list everywhere.** What it was: the subagent learns tools it does not have, and nothing
  catches the day a tool disappears from its set.
- **A rule list per subagent definition.** Three copies of the same sentences, and the copies drift
  the first time a rule changes.
- **Derive the list from the tool set (chosen).** The rule states its own precondition, and the
  section renders what the agent can act on. The call sites do not change when a rule is added.

## Consequences

- `renderForSubagent` takes the tool names, so a section decides with the same information the
  runtime has. The runtime filters the parent's tools first, so the names are what the subagent
  really runs with.
- A rule that names a tool nobody registers would drop silently, and the main prompt would still
  look complete, because it renders every rule. The guard is a test: it reads the rule table and
  proves every name in `needs` is registered in the session.
- A rule about a shell names both dialects, `bash` and `powershell`. One of them satisfies `needs`,
  so the rule survives on a host that registers only one.
