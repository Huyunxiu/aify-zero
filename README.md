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

- Run the development server:

```bash
vp run dev
```

- Add dependency

```bash
vp i xxx --filter ./packages/ui
```

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
