# Glossary Map

本仓库是多上下文布局。每个术语只在一个上下文里定义，其余上下文引用同一套说法。

## Contexts

- [packages/ui](./packages/ui/GLOSSARY.md)：会话面板与其中的各个视图（文件、改动、终端）。
- [packages/agent](./packages/agent/GLOSSARY.md)：会话里的模型循环，以及进入循环的工具、MCP 服务器和扩展。
- [packages/server](./packages/server/GLOSSARY.md)：设置、项目、会话行与凭据；模型和供应商在这里定义。

## Relationships

- **packages/ui ↔ packages/server**：服务端计算改动与基线，用的是同一套词；词表只写在
  `packages/ui/GLOSSARY.md`，服务端不另立说法。
- **packages/agent → packages/ui**：工具和 MCP 工具的名字出现在会话面板里，面板用同一套
  说法显示它们，不另起词。
