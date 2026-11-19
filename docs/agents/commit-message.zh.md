# 提交信息

> 中文副本。以 [`commit-message.md`](./commit-message.md) 为准。

每条提交信息都用 Conventional Commits 1.0.0 的格式。`commit-msg` 钩子会跑 commitlint，不合规则的
信息会被拦住，提交不会发生。

规则本身在 `commitlint.config.ts`。本文件说明这些规则的意思。

## 格式

```
type(scope): subject

body

Refs: AIFY0-78
```

- **type**：`build`、`chore`、`ci`、`docs`、`feat`、`fix`、`perf`、`refactor`、`revert`、`style`、
  `test` 之一。挑能说清这次改动意图的那个。
- **scope**：可省。从下面的名单里挑一个名字。一次改动跨了几块、挑不出单一名字时，就不写。
- **subject**：一句话。用祈使句。首字母小写。结尾不加句号。整个头行不超过 100 个字符。
- **body**：可省。说明为什么要改。每行不超过 100 个字符。头行和正文之间空一行。
- **footer**：可省。Linear 票号写在 `Refs:` 那一行：`Refs: AIFY0-78`。Linear 靠这一行把提交挂到票上。

`type` 和 `scope` 用英文。整条信息都用英文。见 `language.md`。

## 范围

`agent`、`agent-client`、`api`、`config`、`db`、`sandbox`、`server`、`shared`、`ui`、`web`、`desktop`
是工作区的包名。`e2e`、`deps`、`docs`、`repo` 用来盖住没有对应包名的改动。

## 规则

- 不要把票号写进 subject。票号归 footer。分支名也带着它：`feature/aify0-78-e2e-smoke`。
- 一次提交只放一件事。不相关的改动拆成几条提交。
- 不要用 `git commit --no-verify`。那个选项会跳过检查。
- 不要为了跟历史里的旧格式一致，去改已经写好的信息。
- 压缩合并会把 PR 标题变成提交的 subject。PR 标题也按同一格式写。这条钩子查不了，因为那条信息
  是 GitHub 写的。

## 被拦下怎么办

钩子会打出没过的那条规则。按它改信息，再跑一次 `git commit`。已经提交的，用
`git commit --amend -m "<新信息>"` 改。

## 例子

```
feat(agent): keep successful run artifacts

A run that ends well must keep its evidence, or the next run cannot
compare against it.

Refs: AIFY0-78
```
