# 语言

> 中文副本。以 [`language.md`](./language.md)@bcc56a0 为准。

仓库里的每一份 Markdown 都是英文，每一份旁边都有一份中文副本。英文文件是权威，中文副本
是译本。

## 什么是英文

- 仓库里的每一份 Markdown
- 代码注释，含 TSDoc
- 日志，以及人读的错误信息
- 提交信息、PR 标题、PR 描述

英文按 ASD-STE100 写，`AGENTS.md` 这么要求。

## 什么是中文

- 会话里的回复。`AGENTS.md` 要求那里用中文。
- 每一份 `NAME.zh.md` 副本。

## 副本

文档 `NAME.md` 在同目录有一份副本 `NAME.zh.md`。副本在标题下面写一行，说明它的来源：

> 中文副本。以 `commit-message.md@048cfe0` 为准。

- 英文文件是权威。两份对不上时，英文那份算。
- 不要手改 `.zh.md`。在同一次提交里，从英文文件重新生成它。
- 那一行里的 commit 是英文文件最后一次改动的提交。副本指着旧的提交，就是过期了。
  没有检查会因此失败，靠人补。

## 规则之外的路径

- `.agents/skills/`：从别的仓库装进来的。`skills-lock.json` 锁着哈希。不要翻这些文件。
- `.agents/worktrees/` 与 `.claude/worktrees/`：本仓库的副本，不是源。
- `CLAUDE.md`：指向 `AGENTS.md` 的符号链接。

## 还是中文的文档

有些文档在这条规则之前就是中文。`scripts/doc-pairs.manifest.json` 登记了它们。登记过的
文档可以继续是中文。

这份清单只会变短，而且按做事的次序排着。改动一篇登记过的文档时，在同一次提交里做三件事：

1. 写出英文版。
2. 把中文原文移到 `NAME.zh.md`，在标题下面放上来源那行。
3. 从清单里删掉这一条。

没有人往清单里加条目。次序是：先各份 `GLOSSARY.md` 与 `GLOSSARY-MAP.md`，再
`CODING_STANDARDS.md`，再 ADR，再 `plans/`、`development/`、`testing/`，最后是各包
README。

## 提交信息与 PR

格式见 `commit-message.md`。subject、body、PR 标题、PR 描述都写英文。

提交里可以引用中文，例如这次改动改了某个界面文案。引用放在反引号里。

## 代码注释

新写的注释是英文。被改到的注释变成英文。一个中文文件里其余的注释保持中文，直到有人改到
那一段。

## 检查

CI 跑 `vp run check:docs`。检查读清单，报五种缺陷：

- 一份 Markdown 不在清单里，而且没有副本
- 一份副本没有对应的文档
- 清单里留着已经有副本的文档
- 清单里写着一份不存在的文档
- 清单里写着一份副本

没有检查去读语言。语言靠人读。
