# Environment

What this repository needs besides `node_modules`, and what to do when a check fails in
files a change never touched.

## Install

```bash
CI=true vp install --frozen-lockfile
```

A plain `vp install` stops when it must rebuild `node_modules`:

```text
ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY
```

It asks for a terminal to confirm the removal, and an agent shell has none. `CI=true`
answers that question once, for this command. `--frozen-lockfile` keeps the lock file as it
is, so the install cannot change a dependency either.

## Native packages

Three dependencies ship one package per platform:

| Dependency         | What it does                    | Directory              |
| ------------------ | ------------------------------- | ---------------------- |
| `sharp`            | decodes images for attachments  | `node_modules/@img`    |
| `@libsql`          | native binding for the database | `node_modules/@libsql` |
| `@lydell/node-pty` | native binding for the terminal | `node_modules/@lydell` |

They are optional dependencies. An install that skips optional packages leaves them out
and reports no error. The same gap then looks like four unrelated failures:

| Symptom                                  | Where                                                             |
| ---------------------------------------- | ----------------------------------------------------------------- |
| around 120 type errors                   | `packages/agent/src/attachments/`                                 |
| 15 failed tests                          | `attachments/normalize.test.ts`, `tools/read-file.test.ts`        |
| a failed build task                      | `scripts/stage-server-dist.ts`, "sharp platform packages missing" |
| the database or the terminal cannot load | at run time                                                       |

None of those files is the change. `vp run doctor` names the absent package and the command
that installs it.

## The browser

`vp run e2e` needs Chromium. It does not live in `node_modules`; Playwright keeps it in its
own cache, or in `PLAYWRIGHT_BROWSERS_PATH` when that variable is set. `vp run doctor`
reads the same two places.

```bash
vp exec playwright install chromium
```

A Linux machine that cannot install the browser needs the manual steps in
[`docs/testing/e2e.md`](../testing/e2e.md).

## What doctor does not check

It reads directories. It does not run a model, start a server, or look at configuration. A
fresh CI install has every package, so CI does not run it; a local machine that disagrees
with CI is where it helps.
