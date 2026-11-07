# Domain Docs

How the engineering skills consume this repo's domain documentation.

## Layout: multi-context

This repo is a pnpm monorepo. Each app and each package is one context.

```
/
├── GLOSSARY-MAP.md          ← one line per context, points at each GLOSSARY.md
├── docs/adr/                ← system-wide decisions
├── apps/
│   ├── desktop/
│   │   ├── GLOSSARY.md
│   │   └── docs/adr/        ← context-specific decisions
│   ├── server/
│   └── web/
└── packages/
    ├── agent/
    │   ├── GLOSSARY.md
    │   └── docs/adr/
    ├── agent-client/
    ├── api/
    ├── config/
    ├── db/
    ├── server/
    ├── shared/
    └── ui/
```

None of these files exist yet. The `/domain-modeling` skill (reached via `/grill-with-docs` and
`/improve-codebase-architecture`) creates them lazily when terms or decisions get resolved.
Do not create them upfront.

## Before exploring, read these

- **`GLOSSARY-MAP.md`** at the repo root if it exists: it points at one `GLOSSARY.md` per context.
  Read each one relevant to the topic.
- **`GLOSSARY.md`** in each context directory you touch.
- **`docs/adr/`**: read ADRs that touch the area you are about to work in. Also check
  `apps/<name>/docs/adr/` and `packages/<name>/docs/adr/`.

If any of these files do not exist, **proceed silently**. Do not flag their absence; do not
suggest creating them upfront.

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis,
a test name), use the term as defined in the context's `GLOSSARY.md`. Don't drift to synonyms
the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal: either you're inventing
language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (event-sourced orders), but worth reopening because…_
