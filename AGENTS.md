# Guidelines

1. Always respond in Chinese.
2. Avoid unnecessary secondary labels and descriptions. Let the layout do the explaining.
3. Fix a bug at its cause, reasoning from first principles and established best practice. Do not patch over the symptom.
4. Always talk in ASD-STE100 Simplified Technical English. Always read GLOSSARY.md files, and use their ubiquitous language.
5. Explain at ELI5 level by default. Give more depth only when I ask.

<!--VITE PLUS START-->

# Using Vite+, the Unified Toolchain for the Web

This project is using Vite+, a unified toolchain built on top of Vite, Rolldown, Vitest, tsdown, Oxlint, Oxfmt, and Vite Task. Vite+ wraps runtime management, package management, and frontend tooling in a single global CLI called `vp`. Vite+ is distinct from Vite, and it invokes Vite through `vp dev` and `vp build`. Run `vp help` to print a list of commands and `vp <command> --help` for information about a specific command.

Docs are local at `node_modules/vite-plus/docs` or online at https://viteplus.dev/guide/.

## Review Checklist

- [ ] Run `vp install` after pulling remote changes and before getting started.
- [ ] Run `vp check` and `vp test` to format, lint, type check and test changes.
- [ ] Check if there are `vite.config.ts` tasks or `package.json` scripts necessary for validation, run via `vp run <script>`.
- [ ] If setup, runtime, or package-manager behavior looks wrong, run `vp env doctor` and include its output when asking for help.

<!--VITE PLUS END-->

## Environment

`CI=true vp install --frozen-lockfile` installs without a terminal; a plain `vp install`
stops when it must rebuild `node_modules`. When a check fails in files the change did not
touch, run `vp run doctor`: it names the missing native package or browser and the command
that fixes it. See `docs/development/environment.md`.

## Agent skills

### Issue tracker

Issues live in Linear, workspace `Aify0`, team `AIFY0`. See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical roles. Four map to same-named Linear labels; `wontfix` means state `Canceled`. See `docs/agents/triage-labels.md`.

### Domain docs

Multi-context: a root `GLOSSARY-MAP.md` points at one `GLOSSARY.md` per app and package. See `docs/agents/domain.md`.

### Commit messages

Use Conventional Commits. The `commit-msg` hook rejects a message that breaks the rules. Put the Linear key in the `Refs:` footer, not in the subject. Do not use `git commit --no-verify`. See `docs/agents/commit-message.md`.

### Language

Every document is English and has a Chinese copy. A new or changed code comment is English; a comment a change does not touch keeps the language of its file. See `docs/agents/language.md`.

### Review

Judgement calls only: naming from the glossary, one concept per directory, one authoritative rule, tests against their seam. See `CODING_STANDARDS.md`.
