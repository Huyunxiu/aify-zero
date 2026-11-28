# Language

Every Markdown file in this repository is English. Every one has a Chinese copy next to
it. The English file is the authority. The Chinese copy is a translation.

## What is English

- every Markdown file in the repository
- code comments, including TSDoc. A new comment is English, and so is a comment a change
  touches; the comments a change leaves alone keep the language the file already uses (see
  [Code comments](#code-comments))
- log messages and the error messages that a person reads
- commit messages, PR titles, and PR descriptions

English text follows ASD-STE100, as `AGENTS.md` requires.

## What is Chinese

- the reply in a session. `AGENTS.md` asks for Chinese there.
- every `NAME.zh.md` copy.

## The copies

A document `NAME.md` has a copy `NAME.zh.md` in the same directory. The copy opens with one
line under the title that names its source:

> 中文副本。以 `commit-message.md` 为准。

- The English file is the authority. When the two disagree, the English file is right.
- Do not edit a `.zh.md` file by hand. Regenerate it from the English file, in the same
  commit.
- A copy is behind when its English file changed after the copy. The copy does not say
  so. To tell, run `git log -1 --format=%h -- NAME.md` and the same command for
  `NAME.zh.md`, then compare. No check fails. A person looks.

## What is outside the rule

- `.agents/skills/`: skills installed from other repositories, which git does not track.
- `.agents/worktrees/` and `.claude/worktrees/`: copies of this repository, not sources.
- `CLAUDE.md`: a symbolic link to `AGENTS.md`.

`docs/development/skills.md` holds the tracking rule for the skill directory.

## Documents that are still Chinese

Some documents were Chinese before this rule. `scripts/doc-pairs.manifest.json` lists
them. A listed document may stay Chinese.

The list only gets shorter, and it holds the documents in the order of work. When you
change a listed document, do three things in the same commit:

1. Write the English version.
2. Move the Chinese text to `NAME.zh.md`. Put the source line under the title.
3. Delete the entry from the manifest.

Nobody adds an entry to the manifest. The order of work is the `GLOSSARY.md` files and
`GLOSSARY-MAP.md` first, then `CODING_STANDARDS.md`, then the ADRs, then `plans/`,
`development/`, and `testing/`, then the package READMEs.

## Commit messages and PRs

`commit-message.md` holds the format. Write the subject, the body, the PR title, and the
PR description in English.

A commit may quote Chinese text. One example is a UI label that the commit renames. Put
the quote between backticks.

## Code comments

A new comment is English. A comment that you change becomes English. The other comments
in a Chinese file stay Chinese until someone changes that part of the file.

## The comment check

`vp run check:comments` fails on a Chinese comment on a line a commit adds. It reads the
staged diff and the staged content, so a comment the change does not touch is never read —
that is the rule in [Code comments](#code-comments), as a check.

`vp staged` runs it on a commit that stages a TypeScript file, together with formatting and
lint (`vite.config.ts`).

## The document check

CI runs `vp run check:docs`. The check reads the manifest. It reports five defects:

- a Markdown file is not in the manifest, and its copy is absent
- a copy has no document
- the manifest keeps a document that already has a copy
- the manifest names a document that does not exist
- the manifest names a copy

No check reads the language of a document. A person reads that.
