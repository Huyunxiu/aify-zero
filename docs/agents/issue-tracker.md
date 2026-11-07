# Issue tracker: Linear

Issues and specs for this repo live in Linear, workspace `Aify0` (https://linear.app/aify0),
team `AIFY0` (`AIFY0-<n>`). Use the Linear MCP tools (`mcp__linear__*`).
Do not use `gh issue` for this repo.

## Conventions

- **Create an issue**: `save_issue` with `team: "AIFY0"`. Pass `state: "Todo"` when work can
  start now; pass `"Backlog"` when it cannot. Pass `assignee: "me"` unless the user names
  another person. Pass `project: "Aify Zero"` only when the user names a project.
- **Title language**: write the title in the language of the request. The team mixes both.
- **Read an issue**: `get_issue` with `AIFY0-<n>`. Add `includeRelations: true` when blocking matters.
- **List issues**: `list_issues` with `team: "AIFY0"`, plus `state`, `label`, `assignee`, `project`,
  `parentId`, or `query`. Results paginate: follow `cursor` while `hasNextPage` is true.
- **Comment**: `list_comments` reads the discussion. `save_comment` with `issueId` adds a top-level
  comment. `parentId` replies in a thread.
- **Labels**: `addLabels` and `removeLabels` change one or two labels. `labels` replaces the full set.
- **Close**: write the explanation with `save_comment`, then `save_issue` with `state: "Done"`.
  For wontfix, use `state: "Canceled"` and no label (see `docs/agents/triage-labels.md`).
- **Link a PR, commit, or spec**: `links: [{url, title}]` on `save_issue`. Links are append-only.
- **Blocking**: `blockedBy`, `blocks`, `relatedTo` on `save_issue`. They are append-only. Remove an
  edge with `removeBlockedBy`, `removeBlocks`, `removeRelatedTo`. A ticket is startable when every
  blocker is `Done` or `Canceled`.
- **Attach a file**: `prepare_attachment_upload`, PUT the bytes, then `create_attachment_from_upload`.
  To embed an image in markdown, use `prepare_file_upload` and insert the returned markdown.

## Statuses

`Backlog` → `Todo` → `In Progress` → `In Review` → `Done`. `Canceled` means wontfix.
`Duplicate` means duplicate.

## Labels

Team labels: `Bug`, `Feature`, `Improvement`, and the triage labels in `docs/agents/triage-labels.md`.

## Scope

File issues only into team `AIFY0` of workspace `Aify0`. Do not file into other teams or workspaces.

## When a skill says "publish to the issue tracker"

Create a Linear issue in team `AIFY0`.

## When a skill says "fetch the relevant ticket"

Read it as in **Read an issue** above. Read its comments too.

## Wayfinding operations

Used by `/wayfinder`. The **map** is one issue with the label `wayfinder:map`. Its **tickets** are
child issues (`parentId` = the map).

- **Map**: `save_issue` with `team: "AIFY0"`, `labels: ["wayfinder:map"]`. Create the label on first
  use with `save_issue_label`.
- **Child ticket**: `save_issue` with `parentId: "AIFY0-<map>"` and `labels: ["wayfinder:<type>"]`,
  where `<type>` is `research`, `prototype`, `grilling`, or `task`. Create the label on first use.
- **Blocking**: `blockedBy` on the child (see **Blocking** above).
- **Frontier query**: `list_issues` with `team: "AIFY0"`, `parentId: "AIFY0-<map>"`, `state: "Todo"`,
  `assignee: "null"`. Drop any ticket with an open blocker (`get_issue` with `includeRelations: true`).
  First ticket in map order wins.
- **Claim**: `save_issue` with `assignee: "me"`. This is the first write of the session.
- **Resolve**: `save_comment` with the answer, `save_issue` with `state: "Done"`, then append one
  line to the map's Decisions so far.
