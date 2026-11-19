# English is the only language

Every repository text is English. Every document has a Chinese copy next to it. The
English file is the authority.

## Shape

The rule holds in one file: `docs/agents/language.md`. `AGENTS.md` carries one sentence
and the pointer. `commit-message.md` keeps the format of a
commit message and leaves the language to `language.md`.

A document `NAME.md` has a copy `NAME.zh.md`. The copy opens with one line under the title:
`> 中文副本。以 NAME.md@<sha> 为准。` The commit is the last change of the English file.
A copy that names an old commit is out of date. No check fails on it; a person reads the
two and fixes the copy.

The copies are not a second truth. Nobody edits a `.zh.md` file by hand. A change starts
in the English file and the copy follows.

The check is `vp run check:docs`. It reads `scripts/doc-pairs.manifest.json` and reports
five defects: a document without a copy, a copy without a document, a manifest entry that
already has a copy, a manifest entry that names no document, and a manifest entry that
names a copy. The check does not read language.

Old documents stay Chinese. The manifest lists them. A listed document becomes English
in the commit that also changes it: write the English version, move the Chinese text to
the copy, delete the manifest entry. The list only gets shorter.

Code comments are English from this commit on. A comment that nobody touches stays as it
is. The reply in a session stays Chinese.

## Considered Options

- **All Chinese.** The type and the scope of a commit are English words. With a Chinese
  subject, the rules "imperative mood" and "start in lower case" describe nothing.
- **English for interface texts, Chinese for judgement texts.** This was the first
  decision, and it is the better one for a reader whose English is weak. It also leaves
  two rules where the repository needs one, and the choice between them is exactly what
  swayed from session to session. It is recorded here as the option that lost.
- **`.zh-CN.md` instead of `.zh.md`.** The repository already has five `.zh.md` files and
  no `.zh-CN.md` file. `zh` names the language; `zh-CN` claims a regional difference that
  this repository does not make. File names are not locale tags.
- **One bulk translation of the 46 Chinese documents.** One commit would hold 46
  translations and 46 copies. Nobody can read that commit. The manifest burns down
  instead, and every step stays reviewable.
- **Both copies editable.** Two truths. `CODING_STANDARDS.md` would break its own rule
  that a decision has one authority, in the same commit that adds 46 documents.
- **A commitlint rule and a CI job that reject Chinese in the header.** A machine that
  reads language reports false defects: a subject may quote a Chinese label inside
  backticks. The check that stayed is the one that cannot be wrong, because it asks only
  whether a file exists.
- **Keep the old history and rewrite it.** The 13 Chinese subjects stay. A rewrite of the
  remote history buys nothing.

## Consequences

- The reader judges the Chinese copy and the authority is the English file. A correction
  must land in the English file, or the two truths that this decision rejects appear one
  by one. `language.md` says this in one line; it is the weak point of the decision.
- The repository holds about 46 Chinese documents until someone changes them. A document
  that nobody touches stays Chinese for years.
- Every document change costs a translation. The cost lands on the person who changes the
  document, at the moment they know the content best.
- `docs/` doubles in file count. `grep` and review now see two files where one was.
- The language of a commit message has no machine gate. The rule holds because
  `AGENTS.md` points to it and a person reads the result.
