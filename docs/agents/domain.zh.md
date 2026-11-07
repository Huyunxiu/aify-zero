# 领域文档

> 本文件是 [`domain.md`](./domain.md) 的中文镜像。改动要同时改两份。

工程技能在探索代码库时，如何读取本仓库的领域文档。

## 布局：多上下文

本仓库是 pnpm monorepo。每个 app 和每个 package 是一个上下文。

```
/
├── GLOSSARY-MAP.md          ← 每个上下文一行，指向各自的 GLOSSARY.md
├── docs/adr/                ← 系统级决策
├── apps/
│   ├── desktop/
│   │   ├── GLOSSARY.md
│   │   └── docs/adr/        ← 上下文专属决策
│   ├── server/
│   └── web/
└── packages/
    ├── agent/
    │   ├── GLOSSARY.md
    │   └── docs/adr/
    ├── agent-client/
    ├── api/
    ├── config/
    ├── db/
    ├── server/
    ├── shared/
    └── ui/
```

这些文件目前都不存在。`/domain-modeling` 技能（从 `/grill-with-docs` 和 `/improve-codebase-architecture`
进入）会在术语或决策真正定下来时惰性创建它们。不要预先创建。

## 探索之前，先读这些

- **仓库根目录的 `GLOSSARY-MAP.md`**（如果存在）：它指向每个上下文的 `GLOSSARY.md`。读和话题相关的那些。
- **你所触碰的上下文目录里的 `GLOSSARY.md`**。
- **`docs/adr/`**：读和你要改的部分相关的 ADR。另外检查 `apps/<name>/docs/adr/` 和
  `packages/<name>/docs/adr/`。

这些文件不存在时，**静默继续**。不要指出它们缺失，也不要建议预先创建。

## 使用术语表的词汇

输出里出现领域概念时（issue 标题、重构提案、假设、测试名），用该上下文 `GLOSSARY.md` 定义的说法。
不要漂移到术语表明确避开的近义词。

需要的概念还不在术语表里，这是一个信号：要么你在发明项目不用的说法（重新考虑），
要么真的缺一条（记下来交给 `/domain-modeling`）。

## 标出 ADR 冲突

你的输出和已有 ADR 矛盾时，明确说出来，不要悄悄覆盖：

> _和 ADR-0007（event-sourced orders）矛盾，但值得重开，因为……_
