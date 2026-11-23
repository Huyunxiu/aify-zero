# Bot structured config lives in SQLite; file resources live in Bot Home

Structured Bot configuration (identity, default model ref, effort, instructions, tool groups,
default approval policy, sandbox settings, environment variables, MCP server definitions, global
inheritance modes, and default project) is stored in SQLite (`bot` table) as the single source of
truth. File-based resources (`skills/**/SKILL.md`, `AGENTS.md`, and optional `home/`) live in Bot
Home (`~/.aify-zero/bots/<botId>/`), with no mirror `bot.json` or `mcp.json`.

All program-managed directories live under `~/.aify-zero` (overridable via `AIFY_DATA_DIR`), not
Electron `userData` or `~/Documents`: the API server also runs headless without Electron, while OS
Documents folders trigger permission prompts and cloud-sync conflicts. `bot.workspace_dir` reserves
a custom host path column (fixed to `<botHome>/workspace` in v1). Session scratch directories stay
flat at `~/.aify-zero/sessions/<sessionId>`.

Bot-private MCP servers reuse the process-level `McpManager` (extending ADR 0001) using globally
unique server IDs, while stdio transports inherit that Bot's workspace `cwd` and environment map.

## Considered Options

- **File-first config (`bot.json` / `mcp.json` in Bot Home)**: introduces dual-write sync hazards
  with SQLite and splits OAuth credentials (`mcp_credential`) from server definitions.
- **Store under Electron `userData` or `~/Documents`**: unavailable to standalone server runs,
  creates space-containing paths in shell commands, or collides with iCloud/OneDrive sync.
- **Nest sessions under `bots/<botId>/sessions/<sessionId>`**: breaks session deletion, directory
  moves, and `workspace.service.ts` path assumptions.

## Consequences

- Each data kind has one authority: Drizzle/Zod validates structured config and masks env secrets;
  filesystem scanning reads `skills/` and `AGENTS.md` directly.
- Deleting a Bot soft-deletes rows and revokes private MCP credentials while keeping Bot Home on
  disk by default unless the user explicitly opts in to delete local files.
- Bot-private MCP connections share the same connection reuse, idle timeout, and OAuth callback flow
  as global MCP servers.
