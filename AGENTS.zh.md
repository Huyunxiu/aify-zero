# 约定

> 中文副本。以 [`AGENTS.md`](./AGENTS.md) 为准。

1. 回复一律用中文。
2. 不要多余的二级标签与说明。让排版自己说话。
3. 修 bug 要修在成因上，从第一性原理与既有实践推理。不要盖住症状。
4. 一律用 ASD-STE100 Simplified Technical English。先读 GLOSSARY.md，用它规定的说法。

<!--VITE PLUS START-->

# 使用 Vite+：面向 Web 的统一工具链

本项目使用 Vite+，一条建在 Vite、Rolldown、Vitest、tsdown、Oxlint、Oxfmt 与 Vite Task
之上的统一工具链。Vite+ 把运行时管理、包管理与前端工具收进一个全局 CLI，名为 `vp`。Vite+
与 Vite 不是一回事：它通过 `vp dev` 与 `vp build` 调 Vite。`vp help` 列出命令，`vp <command>
--help` 说明其中一条。

文档在本地 `node_modules/vite-plus/docs`，在线在 https://viteplus.dev/guide/。

## 评审清单

- [ ] 拉取远端改动之后、开始干活之前跑 `vp install`。
- [ ] 跑 `vp check` 与 `vp test`，格式化、lint、类型检查并测试改动。
- [ ] 看 `vite.config.ts` 里有没有任务、`package.json` 里有没有验证要用的脚本，用 `vp run
<script>` 跑它们。
- [ ] 若安装、运行时或包管理的行为不对，跑 `vp env doctor`，求助时带上它的输出。

<!--VITE PLUS END-->

## Agent skills

### Issue 跟踪

Issue 在 Linear，workspace `Aify0`，team `AIFY0`。见 `docs/agents/issue-tracker.md`。

### 分诊标签

五个标准角色。其中四个映射到同名的 Linear 标签；`wontfix` 指状态 `Canceled`。见
`docs/agents/triage-labels.md`。

### 领域文档

多上下文：根部的 `GLOSSARY-MAP.md` 指向每个应用与包各一份 `GLOSSARY.md`。见
`docs/agents/domain.md`。

### 提交信息

用 Conventional Commits。`commit-msg` 钩子会拦住不合规则的信息。Linear key 放在 `Refs:`
footer，不放在 subject。不要用 `git commit --no-verify`。见 `docs/agents/commit-message.md`。

### 语言

仓库里的每段文字都是英文，每份文档有一份中文副本。见 `docs/agents/language.md`。

### 测试

端到端用例的说明在 `docs/testing/e2e.md`。跑或改端到端用例之前先读它：里面写了只跑一条
的命令，以及没有 root 时怎么备好浏览器与它的系统库。

### 评审

只留判断题：名字按 glossary、一个目录一个概念、一个判断只有一个权威、测试对着接缝写。见
`CODING_STANDARDS.md`。
