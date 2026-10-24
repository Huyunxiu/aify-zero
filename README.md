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

- Run the development servers (each in its own terminal):

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

Every request to the API must carry `Authorization: Bearer <token>`. The
desktop's main process injects it while forwarding `aify-app://` requests (the
renderer never sees the value), and `dev:web`'s Vite proxy does the same. The
token is read from `AIFY_API_TOKEN` when set; otherwise it is read from
`~/.aify-zero/api-token`, created with mode `0600` on the first server start.
That means `dev:server` and the desktop share one token on the same machine.
Attaching to a server on another machine requires `AIFY_API_TOKEN` in the
desktop's environment. When you override `AIFY_API_TOKEN`, set it for every
process that talks to the server (`dev:server`, `dev:web`, the desktop), or
leave it unset everywhere and use the shared file.

So the packaged app ships and owns its server by default, while `dev:server` +
`dev:desktop` share one process. Only one desktop instance runs at a time: a
second launch focuses the existing window instead of starting another server or
opening the same database. To move a running desktop off the bundled server,
call `aifyDesktop.useServer("http://127.0.0.1:18086")` from the renderer or
DevTools: the main process verifies `/health`, stops the owned child, switches
the `aify-app://` forwarder, and reloads the page. The runtime switch only
accepts loopback origins; configure remote servers with `AIFY_API_ORIGIN` and
`AIFY_API_TOKEN` before launch.

The packaged app creates/migrates `~/.aify-zero/aify-zero.db` from the
migrations bundled at `Resources/migrations` (see
`packagerConfig.extraResource`); the bundled server process runs the migration
on startup. Development uses the repository `local.db` and never auto-migrates
(`db:push` owns the dev schema). If a packaged database was created by
`db:push` it has no migration history: point `DATABASE_URL` at it and run
`vp run db#db:migrate` first, otherwise the packaged app shows a migration error
on launch.

Environment variables are loaded by the process entry, not by library modules:
`apps/server` reads `apps/server/.env` then the repository root `.env`, and the
desktop passes its own environment to the bundled child. A relative
`DATABASE_URL` in a `.env` therefore resolves against the process working
directory — prefer an absolute path or the default.

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
