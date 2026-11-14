# Glossary Map

本仓库是多上下文布局。每个术语只在一个上下文里定义，其余上下文引用同一套说法。

## Contexts

- [packages/ui](./packages/ui/GLOSSARY.md)：会话面板与其中的各个视图（文件、改动、终端）。
- [packages/agent](./packages/agent/GLOSSARY.md)：会话里的模型循环，以及进入循环的工具、MCP 服务器和扩展。
- [packages/server](./packages/server/GLOSSARY.md)：设置、项目、会话行和凭据；模型与供应商在这里定义；浏览器怎么拿到本机 API 的凭据。
- [packages/db](./packages/db/GLOSSARY.md)：表结构与它的版本历史；数据库语境下的迁移、迁移历史、基线按这里的说法用。
- [packages/sandbox](./packages/sandbox/GLOSSARY.md)：工具在哪跑、按什么读写文件；沙箱与沙箱适配器的区别只在这里定义。

## Relationships

- **packages/ui ↔ packages/server**：服务端计算改动与基线，用的是同一套词；词表只写在
  `packages/ui/GLOSSARY.md`，服务端不另立说法。
- **packages/agent → packages/ui**：工具和 MCP 工具的名字出现在会话面板里，面板用同一套
  说法显示它们，不另起词。
- **packages/agent ↔ packages/server**：MCP 的「授权令牌」属于第三方服务器；本机 API
  的「访问令牌」和浏览器的「登录态」是另一回事，不要混用这两个说法。
- **packages/db ← packages/server**：server 启动时应用迁移，失败就不提供服务；「迁移」
  「迁移历史」只按 `packages/db/GLOSSARY.md` 的说法用，「基线」在数据库语境下也按它、
  在改动对比语境下按 `packages/ui/GLOSSARY.md` 的说法用。
- **packages/agent → packages/sandbox**：工具只认沙箱，不认具体环境；沙箱缺少某项能力时，
  对应的工具不注册，而不是注册了再报错。
- **packages/sandbox ↔ packages/server**：server 决定一个会话用哪个适配器、什么时候复用；
  「沙箱」「沙箱适配器」只按 `packages/sandbox/GLOSSARY.md` 的说法用，不叫「提供方」——
  那个词在 `packages/server/GLOSSARY.md` 里已经归模型。
