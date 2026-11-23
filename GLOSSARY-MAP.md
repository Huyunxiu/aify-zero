# Glossary Map

This repository uses a multi-context layout. Each term has one definition in one context,
and the other contexts use the same word.

## Contexts

- [packages/ui](./packages/ui/GLOSSARY.md): the session panel and its views (files, changes,
  terminal).
- [packages/agent](./packages/agent/GLOSSARY.md): the model loop in a session, and the
  tools, MCP servers, and extensions that enter that loop.
- [packages/server](./packages/server/GLOSSARY.md): bots, settings, projects, session rows, and
  credentials; this file defines Bot, Default Bot, Bot Home, Bot Workspace, model, and provider;
  how the browser gets the credential of the local API.
- [packages/db](./packages/db/GLOSSARY.md): the table structure and its version history;
  migration, migration history, and baseline in the database context follow this file.
- [packages/sandbox](./packages/sandbox/GLOSSARY.md): where a tool runs, and which files it
  reads and writes; only this file defines the difference between the sandbox and the
  sandbox adapter.

## Relationships

- **packages/ui ↔ packages/server**: the server counts changes and baselines with the same
  words. The vocabulary is only in `packages/ui/GLOSSARY.md`, and the server does not make
  its own word. (Note: "baseline" here means the baseline of a change comparison. It is not
  the database "baseline" in `packages/db`.)
- **packages/agent → packages/ui**: the names of the transcript, the tools, and the MCP tools
  appear in the session panel. The panel shows them with the same words and does not make a
  new word. "Approval Policy" follows `packages/agent/GLOSSARY.md`, and the interface does
  not make a "permission mode".
- **packages/ui ↔ packages/agent-client ↔ packages/agent**: `packages/agent-client` defines
  the value set of the approval policy. The interface uses this set for its options, the
  server uses it to guard the input, and the agent package uses it to decide.
  `packages/db` does not depend on the protocol package: that column keeps the same literals,
  and its comment names the object that it aligns with.
- **packages/agent ↔ packages/server**: the "authorization token" of MCP belongs to a
  third-party server. The "access token" of the local API and the "login state" of the
  browser are different things. Do not mix these words.
- **packages/server ↔ packages/agent**: the runner starts a run, and the run executes in a
  session. Turn, transcript, run, inbox, inbox item, outbox, delivery, runner, and paused all
  follow `packages/agent/GLOSSARY.md`. The inbox is the inbound side; do not mix it with the
  outbox.
- **apps/desktop ← packages/agent**: the desktop does one thing: it changes one "delivery"
  into one system notification. It has no vocabulary of its own, and it does not call an
  outbox item a "notification". "Notification" stays with the "completion notice" of
  `packages/agent`.
- **packages/db ← packages/server**: the server applies the migrations at startup, and it
  does not serve if a migration fails. "Migration" and "migration history" follow only
  `packages/db/GLOSSARY.md`. "Baseline" follows that file in the database context, and
  `packages/ui/GLOSSARY.md` in the change-comparison context.
- **packages/server → packages/agent**: "time zone" has its definition only in
  `packages/server/GLOSSARY.md`. The rule of a schedule holds a copy, and that copy does not
  follow the setting after it is written.
- **packages/agent → packages/sandbox**: a tool knows only the sandbox, not a specific
  environment. If the sandbox lacks a capability, the matching tool does not register; it
  does not register and then report an error.
- **packages/sandbox ↔ packages/server**: the server decides which adapter a session uses,
  and when it reuses that adapter. "Sandbox" and "sandbox adapter" follow only
  `packages/sandbox/GLOSSARY.md`, and they are not "provider": that word already belongs to
  the model in `packages/server/GLOSSARY.md`.
- **packages/server → packages/agent, packages/ui**: `Bot`, `Default Bot`, `Bot Home`, and
  `Bot Workspace` are defined in `packages/server/GLOSSARY.md`. They are distinct from the
  model loop (`packages/agent/GLOSSARY.md`), and UI views use `Bot` rather than `Agent`.
