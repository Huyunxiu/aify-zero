# Commit messages

Write every commit message in Conventional Commits 1.0.0 format. The `commit-msg` hook runs
commitlint. A message that breaks a rule stops the commit.

The rules live in `commitlint.config.ts`. This file explains them.

## Format

```
type(scope): subject

body

Refs: AIFY0-78
```

- **type**: one of `build`, `chore`, `ci`, `docs`, `feat`, `fix`, `perf`, `refactor`, `revert`,
  `style`, `test`. Pick the type that names the intent of the change.
- **scope**: optional. Pick one name from the list below. Leave it out when the change touches
  more than one area and no single name fits.
- **subject**: one clause. Use the imperative mood. Start in lower case. Do not end with a period.
  Keep the whole header at 100 characters or less.
- **body**: optional. Say why the change is necessary. Keep each line at 100 characters or less.
  Put one blank line between the header and the body.
- **footer**: optional. Put the Linear key on a `Refs:` line: `Refs: AIFY0-78`. Linear links the
  commit to the issue from this line.

`type` and `scope` are English. So is every other part of the message. See `language.md`.

## Scopes

`agent`, `agent-client`, `api`, `config`, `db`, `sandbox`, `server`, `shared`, `ui`, `web`, and
`desktop` are the workspace packages. `e2e`, `deps`, `docs`, and `repo` cover a change that no
package name describes.

## Rules

- Do not put the ticket key in the subject. The key goes in the footer. The branch name also
  carries the key: `feature/aify0-78-e2e-smoke`.
- One commit, one change. Split unrelated changes into separate commits.
- Do not use `git commit --no-verify`. That option skips the check.
- Do not rewrite a message to match an older, wrong format in the history.
- A squash merge turns the PR title into the commit subject. Write the PR title in the same format.
  The hook cannot check it, because GitHub writes that message.

## When the hook rejects a message

The hook prints the rule that failed. Correct the message, then run `git commit` again. For a
message that is already committed, run `git commit --amend -m "<new message>"`.

## Example

```
feat(agent): keep successful run artifacts

A run that ends well must keep its evidence, or the next run cannot
compare against it.

Refs: AIFY0-78
```
