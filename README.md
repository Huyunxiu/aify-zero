# Vite+ Monorepo Starter

English | [简体中文](README.zh.md)

A starter for creating a Vite+ monorepo.

## Development

- Check everything is ready:

```bash
vp run ready
```

- Run the tests:

```bash
vp run -r test
```

- Build the monorepo:

```bash
vp run -r build
```

- Run the API and the browser UI together in one terminal:

```bash
vp run dev
```

- Run the development servers separately (each in its own terminal):

```bash
vp run dev:server   # standalone Hono API on 127.0.0.1:18086 (apps/server)
vp run dev:web      # browser UI on 127.0.0.1:3000, proxies /api to the API
vp run dev:desktop  # Electron shell; loads the UI through aify-app://
```

`dev:web` and `dev:desktop` both bind `127.0.0.1:3000` (strictPort), so run one
of them at a time. `dev:desktop` does not require `dev:server`: when nothing is
listening on the API port it starts the bundled server itself (see below).
Ports can be overridden with `AIFY_API_PORT`, `AIFY_WEB_PORT` and
`AIFY_API_ORIGIN`.

`dev:api` remains as an alias for `dev:server`.

- Add dependency

```bash
vp i xxx --filter ./packages/ui
```

## Desktop shell

The packaged app loads `aify-app://app/`. An Electron `protocol.handle` handler
serves the built renderer from disk and forwards the `/api` namespace to
the API server (a real HTTP origin, see below); in development it proxies the
document requests to Vite so HMR keeps working. `AIFY_APP_PROTOCOL=0` loads the
Vite URL directly instead (escape hatch for debugging).

### API server modes

The API lives in `apps/server` (`@workspace/server-app`) and is the only
listener. The desktop chooses one of three modes with `AIFY_SERVER_MODE`:

| Mode             | Behavior                                                                                                                                                                                                                    |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auto` (default) | Use `AIFY_API_ORIGIN` when set; otherwise probe `AIFY_API_HOST:AIFY_API_PORT` (default `127.0.0.1:18086`, retried briefly in development) and attach if a server answers `GET /health`; otherwise start the bundled server. |
| `owned`          | Always start the bundled server in a `utilityProcess` (`.vite/build/server-entry.js`). `AIFY_API_ORIGIN` is ignored in this mode.                                                                                           |
| `attach`         | Never start the bundled server; require an external one at `AIFY_API_ORIGIN` or the default origin.                                                                                                                         |

The bundled server uses an OS-assigned port by default (the ready line reports
it), because the renderer always goes through the main process. Set
`AIFY_API_PORT` to force a fixed port. `AIFY_APP_PROTOCOL=0` needs a fixed
`AIFY_API_PORT` (or `AIFY_API_ORIGIN`), since the Vite proxy is configured
before the server starts.

The renderer window opens while the bundled server is still starting. The
`aify-app://` handler holds early API requests until the server reports ready
and answers `503` (with `retry-after`) only when it cannot. An owned server
that exits after becoming ready is restarted up to three times with backoff;
transient 503s from that window are retried by the query client for a few
seconds. The main process also pushes `server-status` to the renderer, which
shows a small banner while the server is starting or reconnecting.

The browser signs in with a link. At every start the server prints
`[auth] sign in: http://…/?token=…`. The address is the web app itself: the page
posts the token to `/api/auth/login`, receives the HttpOnly `aify_session`
cookie, and strips the token from the address bar. Later requests, `<img src>`
loads and WebSocket handshakes carry that cookie automatically. The token does
not expire with time: it stays usable until the server restarts, and works for
more than one device. Sessions last 30 days and renew on use. Settings → General
can mint another link; the same call is `POST /api/auth/login-link`.

Machine clients still send `Authorization: Bearer <token>`: the desktop's main
process injects it while forwarding `aify-app://` requests (the renderer never
sees the value), and the CLI does the same. The token is read from
`AIFY_API_TOKEN` when set; otherwise it is read from `~/.aify-zero/api-token`,
created with mode `0600` on the first server start. The Vite dev proxy only
forwards now: browsers carry the cookie, not the token.

When the built web app exists (`apps/web/dist` or `AIFY_WEB_ROOT`), the server
serves it from `/`, so remote access stays same-origin and needs no CORS. Set
`AIFY_PUBLIC_ORIGIN` for remote deployments: it decides the printed link's
host and whether the cookie gets `Secure`. Set `AIFY_WEB_ORIGIN` when the page
is served by a separate dev server. Plain http works on a LAN, but the ticket
and cookie cross the network unencrypted; use HTTPS beyond a trusted network.

So the packaged app ships and owns its server by default, while `dev:server` +
`dev:desktop` share one process. Only one desktop instance runs at a time: a
second launch focuses the existing window instead of starting another server or
opening the same database. To move a running desktop off the bundled server,
call `aifyDesktop.useServer("http://127.0.0.1:18086")` from the renderer or
DevTools: the main process verifies `/health`, stops the owned child, switches
the `aify-app://` forwarder, and reloads the page. The runtime switch only
accepts loopback origins; configure remote servers with `AIFY_API_ORIGIN` and
`AIFY_API_TOKEN` before launch.

Migration files are the only source of schema, and every server start applies
them. The packaged app migrates `~/.aify-zero/aify-zero.db` from the migrations
bundled at `Resources/migrations` (see `packagerConfig.extraResource`);
`dev:server`, `dev:desktop` and the standalone `apps/server` build migrate the
checkout's `local.db`, which every worktree owns. A failed migration stops
startup instead of serving tables that do not match the code.

Schema changes therefore need a migration: run `vp run db#db:generate`, review
the generated SQL, and commit it. `vp ready` runs `db:check`, which fails when
the schema has changes without a migration. A database that has tables but no
migration history cannot start, because it was built before this rule: run
`vp run db#db:baseline` once to mark its existing schema as applied without
replaying any SQL, or delete the file and let startup recreate it. The drizzle
commands (`db:baseline`, `db:migrate`, `db:studio`) act on the checkout
`local.db` by default; set `DATABASE_URL` to target another database.

Environment variables are loaded by the process entry, not by library modules:
`apps/server` reads `apps/server/.env` then the repository root `.env`, and the
desktop passes its own environment to the bundled child. A relative
`DATABASE_URL` in a `.env` therefore resolves against the process working
directory — prefer an absolute path or the default.

## Packaging

Both apps ship their own ripgrep binary: the agent's `glob`/`grep` tools execute
it, and an executable can neither be inlined into a JS bundle nor run from
inside an asar archive. `scripts/stage-ripgrep.ts` copies the binary that
`@vscode/ripgrep` provides for the current platform and restores its executable
bit.

- Desktop: `vp run package:desktop` stages `apps/desktop/resources/bin/rg`
  before packaging, `packagerConfig.extraResource` carries it into
  `Resources/resources/bin`, and the main process points `AIFY_RIPGREP_PATH` at
  it (and prepends the directory to `PATH`) before forking the bundled server.
- Server: `vp run package:server` builds `apps/server/dist` with Vite, then runs
  `scripts/stage-server-dist.ts` to add `node_modules/@libsql/` (the native
  binding), `bin/rg`, and an ESM `package.json`. The result is self-contained;
  run it with `node apps/server/dist/index.js` (the entry sets
  `AIFY_RIPGREP_PATH` when `bin/rg` exists).

The agent resolves `AIFY_RIPGREP_PATH` first, then a staged `bin/rg`, and only
then `rg` from `PATH`, so development keeps working without a packaged binary.

## Adding components

To add components to your app, run the following command at the root of your `web` app:

```bash
vpx shadcn@latest add button -c apps/electron
```

This will place the ui components in the `packages/ui/src/components` directory.

## Using components

To use the components in your app, import them from the `ui` package.

```tsx
import { Button } from "@workspace/ui/components/button";
```

## Debug

### .vscode/launch.json

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "type": "node",
      "request": "launch",
      "name": "Debug Desktop (Electron Main)",
      "cwd": "${workspaceFolder}/apps/desktop",
      "runtimeExecutable": "${workspaceFolder}/node_modules/.bin/electron-forge",
      "runtimeArgs": ["start"],
      "console": "integratedTerminal",
      "autoAttachChildProcesses": true,
      "sourceMaps": true,
      "outFiles": ["${workspaceFolder}/apps/desktop/.vite/build/**/*.js"],
      "skipFiles": ["<node_internals>/**", "**/node_modules/**"]
    }
  ]
}
```
