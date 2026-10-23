# Vite+ Monorepo Starter

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
vp run dev:api      # Hono API on 127.0.0.1:18086
vp run dev:web      # browser UI on 127.0.0.1:3000, proxies /rpc to dev:api
vp run dev:desktop  # Electron shell; loads the UI through aify-app://
```

`dev:web` and `dev:desktop` both bind `127.0.0.1:3000` (strictPort), so run one
of them at a time. Ports can be overridden with `AIFY_API_PORT`, `AIFY_WEB_PORT`
and `AIFY_API_ORIGIN`.

- Add dependency

```bash
vp i xxx --filter ./packages/ui
```

## Desktop shell

The packaged app loads `aify-app://app/`. An Electron `protocol.handle` handler
serves the built renderer from disk and forwards `/rpc` and `/api-reference` to
the in-process Hono app; in development it proxies the same requests to Vite so
HMR keeps working. `AIFY_APP_PROTOCOL=0` loads the Vite URL directly instead
(escape hatch for debugging).

The packaged app creates/migrates `~/.aify-zero/aify-zero.db` on startup from the
migrations bundled at `Resources/migrations` (see `packagerConfig.extraResource`).
If that database was created by `db:push` it has no migration history: point
`DATABASE_URL` at it and run `vp run db#db:migrate` first, otherwise the packaged
app shows a migration error on launch.

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
