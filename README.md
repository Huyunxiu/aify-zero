# Aify Zero

The workspace holds `apps/desktop` (Electron shell), `apps/server` (API),
`apps/web` (browser UI), and `packages/` for the UI, agent, server and sandbox
code.

## Prerequisites

Install the Vite+ CLI:

```bash
curl -fsSL https://vite.plus | bash
```

Open a new shell. `vp` installs Node.js from `.node-version` and pnpm from
`packageManager`, so you install neither yourself.

If setup looks wrong, run `vp env doctor`.

## Install

```bash
vp install
```

Run it after you pull changes.

## Start development

| Command              | Starts                                      |
| -------------------- | ------------------------------------------- |
| `vp run dev:desktop` | Renderer dev server, Electron shell, API    |
| `vp run dev`         | API and browser UI (UI on `127.0.0.1:3000`) |
| `vp run dev:server`  | API on `127.0.0.1:18086`                    |
| `vp run dev:web`     | Browser UI on `127.0.0.1:3000`              |

- `dev:desktop` uses the server on `127.0.0.1:18086` when one answers. If none
  answers, it starts its own server on a free port. It runs alone or next to
  `dev:server`.
- `dev:web` needs a server. Run `vp run dev`, or run `dev:server` first.
- `dev:web` and `dev:desktop` both bind `127.0.0.1:3000` and stop on a busy
  port. Run one at a time.
- The browser signs in with a link. The server prints it at start:
  `[auth] sign in: http://…/?token=…`. Open the link once. The session cookie
  lasts 30 days. The desktop window needs no link: the main process holds the
  token.
- The first start has no provider. Add one in Settings → Providers, or point it
  at the fake provider described in [Debug](#agent-and-provider).
- Ports come from `AIFY_API_PORT` (default `18086`) and `AIFY_WEB_PORT` (default
  `3000`). Set `AIFY_API_ORIGIN` to use a server on another origin. See
  [Desktop shell and API](docs/development/desktop-and-api.md).
- Each checkout has its own `local.db`. The server applies migrations at start.
  After a schema change, run `vp run db:generate`, review the SQL, and commit the
  migration.

### Add a UI component

The UI lives in `packages/ui`. From the repository root:

```bash
vpx shadcn@latest add button -c apps/web
```

The files land in `packages/ui/src/components`. Import them from
`@workspace/ui/components/button`.

## Debug

### Renderer

DevTools opens with the window. Set `AIFY_OPEN_DEVTOOLS=0` to keep it closed.
React DevTools installs on first start.

`dev:web` uses the browser's DevTools.

The window loads `aify-app://app/`. Document requests proxy to Vite, so HMR
works in the window.

### Main process

In VS Code, run **Debug Desktop (Electron Main)** from the Run and Debug panel.
The configuration is in [.vscode/launch.json](.vscode/launch.json). It runs
`electron-forge start` and attaches with source maps, so breakpoints in
`apps/desktop/src` work. Stop `dev:desktop` first: both bind port 3000.

### Logs

| What                    | Where                                                                         |
| ----------------------- | ----------------------------------------------------------------------------- |
| Vite, API server, agent | The terminal that runs the dev command                                        |
| Main process            | `~/Library/Logs/Aify Zero/main.log` on macOS, `app.getPath("logs")` elsewhere |
| Renderer                | The DevTools console and network panel                                        |

The server prints `[api] listening on …`, the sign-in link, and migration
errors.

### API

`/api` routes and `/health` need the token. The token is in
`~/.aify-zero/api-token` (mode 0600), or in `AIFY_API_TOKEN` when set.

```bash
curl -H "authorization: Bearer $(cat ~/.aify-zero/api-token)" \
  http://127.0.0.1:18086/health
# {"ok":true,"pid":…,"uptime":…}
```

Load the page from Vite, not from the app protocol:

```bash
AIFY_APP_PROTOCOL=0 AIFY_API_PORT=18086 vp run dev:desktop
```

Vite configures its proxy before the server starts, so the port must be fixed.
Use this when the `aify-app://` handler is the suspect.

### Agent and provider

Run a fake provider to control failures, slow streams and mid-stream errors:

```bash
vp run fake:provider -- --scenario retry-then-succeed
```

Then add a provider with baseURL `http://127.0.0.1:4030/v1`. The scenarios and
the expected screen are in
[docs/testing/fake-provider.md](docs/testing/fake-provider.md).

### Database

```bash
vp run db:studio   # inspect the checkout database
vp run db:check    # fail when the schema has no migration
```

Set `DATABASE_URL` to target another database.

### Checks

| Command              | Checks                                         |
| -------------------- | ---------------------------------------------- |
| `vp check`           | Format, lint, type check                       |
| `vp check --fix`     | The same, and applies fixes                    |
| `vp test`            | Every test suite                               |
| `vp test watch`      | Every suite, again on change                   |
| `vp test run <path>` | The tests that match a path                    |
| `vp run ready`       | `db:check`, `check`, `test`, then a full build |

## Read more

- [Desktop shell and API](docs/development/desktop-and-api.md): server modes,
  sign-in, migrations, environment variables.
- [Packaging](docs/development/packaging.md): the desktop and server artifacts.
- [Sandbox](packages/sandbox/README.md): where tools run and what they write.
- [Fake provider](docs/testing/fake-provider.md): provider scenarios and
  recordings.
- [ADRs](docs/adr): why the system works this way.
- [Glossaries](GLOSSARY-MAP.md): the terms each package uses.
