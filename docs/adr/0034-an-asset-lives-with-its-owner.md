# An asset lives with its owner and travels through one byte route

A file that the application serves to the browser belongs to exactly one owner: one Bot or one
session. It is stored under that owner's directory (`<botHome>/assets/`, `<sessionDir>/assets/`)
and reaches the browser through a single byte route, `GET /api/asset?owner=<kind>:<id>&name=<base>`,
which resolves the owner to a root and then serves bytes the same way `/api/workspace/file`
already did: versioned redirect to `?v=<mtime:size>`, `private, immutable` caching, `nosniff`, and
a `CSP: sandbox` policy. Uploads take the multipart form `POST /api/asset`, and removal is
`DELETE /api/asset`; both name the owner, never a specific Bot.

Ownership is a rule, not a directory layout. A Bot is a row, and its deletion rule (keep or delete
`<botHome>`) decides whether its assets go; a session's file tree is created on demand and is not
removed by the soft delete of its row. Nothing is collected centrally, so no garbage collector, no
reference count, and no owner column has to be invented.

The Bot's recorded avatar is a file name in `bot.avatar_path`, written only by the asset route
after the bytes land. The client cannot set it: a path in a request is a path a reader can point
anywhere.

## Considered Options

- **One central assets directory with an owner column**: rebuilds ownership, deletion, and access
  checks in metadata, and requires a collector for rows whose owner is gone.
- **A local S3-compatible daemon (MinIO) as a sidecar**: costs a per-platform binary the Forge
  makers must carry, an extra listening port and credentials, an AGPL licensing obligation, and a
  second process whose lifecycle the desktop's server manager does not own.
- **Base64 through the RPC layer**: puts binary in JSON, needs a size limit in a schema rather than
  at the transport, and mixes a 2 MB image into the same call that renames a Bot.
- **Content-addressed names** (`avatar-<sha256>.webp`): trades "delete the old file" for "accumulate
  orphans", which brings back the collector this decision avoids.

## Consequences

- A new owner kind costs one registry entry (`root`, plus an optional post-write hook); the three
  routes stay unchanged.
- Assets are invisible to a Bot's tools unless the owner directory is already a root they can read:
  a Bot's `assets/` is not one of the sandbox mounts.
- One base name keeps exactly one file; changing the format deletes the previous extension instead
  of leaving two files that disagree.
- A session's assets outlive its row, because the session directory does too. That is a deliberate
  debt of the soft delete, not something the asset layer hides.
