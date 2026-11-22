# Skills

A skill in `.agents/skills/` comes from another repository. `skills-lock.json` records the source, the commit, and the content hash of every installed skill. git does not track the skill files: `.gitignore` ignores `/.agents/skills/*`.

Run this command to install every recorded skill:

```sh
vp run skills:install
```

The command restores each skill from its recorded source at the recorded commit. The script passes `--frozen-lockfile`, so the command never rewrites `skills-lock.json`; it stops when the lock no longer describes the source. The script also passes `--agent universal`, which writes only `.agents/skills/`. Add `--agent <name>` when you also want that agent's directory, and expect its files in `git status`.

Run `npx --yes skills@<version> add <source>` to add a skill. Use the version that `package.json` pins, because a new CLI version can rewrite the lock file. The command writes the entry into `skills-lock.json`. Commit the lock file. Do not commit the skill files.

`.claude/skills` is a symbolic link to `.agents/skills`. Claude Code reads that path. DSH reads `.agents/skills` directly and ignores `.claude/skills`.

## Why the files stay out of git

An installed skill is another repository's text. A person there changes it, and this repository cannot correct it. A clone restores the same set from one file, `skills-lock.json`, and does not carry a copy of each skill.
