# The prompt is ordered by volatility

The prompt is one string, sent whole with every step request. A prefix cache compares bytes: the
first byte that differs ends the shared prefix, and every token after it is sent and prefilled
again. Two values in the prompt change on their own — the session directory, once per session, and
the date, once per day — and both sat near the front: the session directory was the second line of
the environment block, the date its last. Every new session and every new day therefore forked
about twenty lines in, and the rules, the approval notice, the project instructions, the skills,
the catalogue and the tool catalog were never shared.

The rule: a block that changes on its own runs after every block that does not. The environment
block keeps the project directories and the machine facts; a `This session` block carries the
session directory and the date and runs at priority 100, after the built-in catalogue at 90. The
date is read when the block renders, not when the extension is built, so a session that crosses
midnight states the right day on its next turn.

## Considered Options

- **Leave the date in the environment block.** The two values that change stay ahead of everything
  stable, so the prefix forks early by design.
- **Move the whole environment block to the end.** It gains only the project directories, which do
  not change inside a project, and it puts the machine facts far from the tools that use them.
- **Put the date in the user turn.** The message prefix then changes on every turn, and the
  messages are the larger half of the request.
- **Order by volatility (chosen).** The stable blocks first, the two changing values last.

## Consequences

- A new session, or a new day, rewrites only the last block. Everything before it keeps the prefix
  a provider has already cached.
- A host block registered above 100, or an environment priority raised past 100, runs after
  `This session`, and the prefix is stable only up to it. The priority numbers say so.
- A section added later that carries a value changing on its own belongs here, at the end, not
  beside the environment.
- The date is read once per turn because the prompt renders once per turn. A change takes effect on
  the next turn, and every step inside a turn reads the same bytes.
