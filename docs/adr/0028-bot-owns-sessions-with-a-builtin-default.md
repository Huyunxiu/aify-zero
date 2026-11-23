# A Bot owns every session, with a built-in Default Bot and orthogonal projects

Every session belongs to one Bot (`session.bot_id` is `NOT NULL`), with a built-in Default Bot
(`id = "default"`) that cannot be deleted and owns both out-of-the-box sessions and existing
sessions after upgrade. Projects remain orthogonal mountable workspaces: a Bot can bind one default
project, and each session can mount one project or work directly in the Bot Workspace.

We separate session-level defaults from live Bot capabilities:

- **Session-level values** (chosen model and effort, approval policy, and attached project) copy
  from the Bot when the session is first created, then stay independent on that session.
- **Bot-level capabilities** (instructions, skills, MCP servers, built-in tool groups, sandbox
  configuration, environment variables, and compaction overrides) resolve from the Bot on every Run,
  so edits apply on the next Run without breaking existing sessions.

## Considered Options

- **Merge Project into Bot**: removes the shared Project abstraction, making multi-Bot collaboration
  on one repository duplicate directory config and git baseline ownership.
- **Nullable `session.bot_id`**: forces two assembly paths (`with Bot` vs `legacy global`) across
  `buildSessionAgent`, workspace resolution, and UI session creation.
- **Bot as a lightweight session template**: leaves no persistent home for cross-session workspace
  files, private skills, or dedicated session history.

## Consequences

- `buildSessionAgent` and `resolveSessionWorkspace` share one code path for every session, with no
  nullable Bot fallback branch.
- Existing sessions migrate cleanly into `default`, whose default settings inherit global skills,
  global MCP servers, and global `AGENTS.md` to preserve prior behavior.
- Deleting a custom Bot rejects while any of its sessions is `running` or `wait_review`, then
  soft-deletes its sessions (ADR 0022) instead of reparenting them back to `default`.
