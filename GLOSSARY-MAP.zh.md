# Glossary Map

> 中文副本。以 [`GLOSSARY-MAP.md`](./GLOSSARY-MAP.md) 为准。

本仓库是多上下文布局。每个术语只在一个上下文里定义，其余上下文引用同一套说法。

## Contexts

- [packages/ui](./packages/ui/GLOSSARY.md)：会话面板与其中的各个视图（文件、改动、终端）。
- [packages/agent](./packages/agent/GLOSSARY.md)：会话里的模型循环，以及进入循环的工具、MCP 服务器和扩展。
- [packages/server](./packages/server/GLOSSARY.md)：Bot、设置、项目、会话行和凭据；Bot、默认 Bot、Bot 主目录、Bot 工作目录、模型与供应商在这里定义；浏览器怎么拿到本机 API 的凭据。
- [packages/db](./packages/db/GLOSSARY.md)：表结构与它的版本历史；数据库语境下的迁移、迁移历史、基线按这里的说法用。
- [packages/sandbox](./packages/sandbox/GLOSSARY.md)：工具在哪跑、按什么读写文件；沙箱与沙箱适配器的区别只在这里定义。

## Relationships

- **packages/ui ↔ packages/server**：服务端计算改动与基线，用的是同一套词；词表只写在
  `packages/ui/GLOSSARY.md`，服务端不另立说法。
  （注意：这里的「基线」指改动对比的基线，和 `packages/db` 里数据库的「基线」不是一回事。）
- **packages/agent → packages/ui**：会话记录、工具和 MCP 工具的名字出现在会话面板里，面板
  用同一套说法显示它们，不另起词。「审批策略」按 `packages/agent/GLOSSARY.md` 的说法用，
  界面不另立「权限模式」。
- **packages/ui ↔ packages/agent-client ↔ packages/agent**：审批策略的值域由
  `packages/agent-client` 定义；界面拿它做选项，服务端拿它守入参，agent 包拿它做
  判定。`packages/db` 不依赖协议包，那一列保留同样的字面量并在注释里指明对齐对象。
- **packages/agent ↔ packages/server**：MCP 的「授权令牌」属于第三方服务器；本机 API
  的「访问令牌」和浏览器的「登录态」是另一回事，不要混用这两个说法。
- **packages/server ↔ packages/agent**：运行器启动运行，运行在会话里跑；「回合」「会话记录」
  「运行」「收件箱」「待办项」「发件箱」「投递」「运行器」「暂停」都按
  `packages/agent/GLOSSARY.md` 的说法用。收件箱是入站的那一侧，不要和发件箱混用。
- **apps/desktop ← packages/agent**：桌面只做一件事——把一次「投递」变成一条系统通知。
  它没有自己的词表，也不把发件项叫「通知」；「通知」留给 `packages/agent` 的「完成通知」。
- **packages/db ← packages/server**：server 启动时应用迁移，失败就不提供服务；「迁移」
  「迁移历史」只按 `packages/db/GLOSSARY.md` 的说法用，「基线」在数据库语境下也按它、
  在改动对比语境下按 `packages/ui/GLOSSARY.md` 的说法用。
- **packages/server → packages/agent**：「时区」只在 `packages/server/GLOSSARY.md` 里定义；
  日程的规则带一份副本，写进去之后不再跟着设置走。
- **packages/agent → packages/sandbox**：工具只认沙箱，不认具体环境；沙箱缺少某项能力时，
  对应的工具不注册，而不是注册了再报错。
- **packages/sandbox ↔ packages/server**：server 决定一个会话用哪个适配器、什么时候复用；
  「沙箱」「沙箱适配器」只按 `packages/sandbox/GLOSSARY.md` 的说法用，不叫「提供方」——
  那个词在 `packages/server/GLOSSARY.md` 里已经归模型。
- **packages/server → packages/agent, packages/ui**：「Bot」「默认 Bot」「Bot 主目录」「Bot 工作目录」
  定义在 `packages/server/GLOSSARY.md`。「Agent」和「Subagent」留在 `packages/agent/GLOSSARY.md`，
  界面沿用 `Bot`，不叫「Agent」或「智能体」。
