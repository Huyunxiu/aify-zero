# 技能

> 中文副本。以 [`skills.md`](./skills.md) 为准。

`.agents/skills/` 里的技能来自别的仓库。`skills-lock.json` 记下每个技能的来源、提交和内容哈希。
git 不跟踪这些技能文件：`.gitignore` 忽略了 `/.agents/skills/*`。

要装回锁文件里记着的每个技能，跑：

```sh
vp run skills:install
```

这条命令按记下的提交从记下的来源恢复每个技能。脚本传了 `--frozen-lockfile`，所以它绝不改写
`skills-lock.json`；锁不再描述来源时它就停下。脚本还传了 `--agent universal`，只写
`.agents/skills/`。也要写某个 agent 的目录时，加 `--agent <name>`，并预期它的文件会出现在
`git status` 里。

要加一个技能，跑 `npx --yes skills@<version> add <source>`。版本用 `package.json` 锁着的那个，因为
新的 CLI 版本可能重写锁文件。这条命令把条目写进 `skills-lock.json`。提交锁文件，不要提交技能文件。

`.claude/skills` 是指向 `.agents/skills` 的符号链接。Claude Code 读那条路径。DSH 直接读
`.agents/skills`，不看 `.claude/skills`。

## 为什么这些文件不进 git

装进来的技能是别的仓库的文本。那边的人改它，这个仓库改不了它。clone 之后靠一个文件
`skills-lock.json` 就能恢复同一套，不必为每个技能各带一份副本。
