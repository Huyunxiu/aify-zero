# 运行器属于 agent 包

会话的推进今天由 `packages/server` 负责：`SessionLifecycle` 开回合、恢复审批、停止、
压缩和 fork，`SessionRunner` 从收件箱取件、暂停、唤醒，启动恢复写在 `serve.ts`。
`packages/agent` 只有一次运行的循环。结果是：想复用 agent 的人必须把这三段重写一遍；
server 又反过来深引用 agent 的内部（`AgentSession`、`STREAM_REGISTRY`、`AgentInbox`、
恢复模块），两边都不是稳定的边界。

这个决定把会话的推进收回 `packages/agent`，对外只留一个对象：`AgentRunner`。它拥有
收件箱循环、暂停、唤醒、启动恢复，以及会话的 create / resume / stop / compact / fork。
内部仍然分成 `SessionLifecycle`（一次会话的状态转换）和取件循环（什么时候跑），但只有
运行器是对外入口。

## Considered Options

- **留在 server，只加公开入口**：改动最小，但 server 仍然拥有 agent 的领域逻辑；
  SDK 的用户还是得重写会话推进。边界只是名字变了。
- **拆成 `AgentRunner` + `AgentSessions`**：`运行器` 只管“什么时候跑”，`AgentSessions`
  管 create/fork/compact，词义最准。代价是 SDK 多一个入口，而且 server 路由要在两个对象
  之间选，调用方也要理解两者的关系。
- **一个 `AgentRunner`（选中）**：`SessionLifecycle` 变成内部类，运行器吸收五个会话
  操作。`运行器` 的定义从“决定何时开始下一次运行”扩成“拥有会话的推进与运行锁”。
  一个入口，Phase 1 的迁移面最小。

## Consequences

- server 不再直接起跑。HTTP 路由只写收件箱、唤醒运行器；`stop` / `compact` / `fork`
  也走运行器。主会话的运行只有一个起点。
- 运行器是实例，不是进程单例。每个实例持有自己的 `StreamEventRegistry` 和
  `SessionEventRegistry`；同一个会话必须只由一个实例处理，否则锁会分裂。
- 子会话工厂必须接收运行器的注册表。不传就会回落到进程级单例，子会话绕过实例锁。
  这条在 `createSubagentFactory` 的参数里显式化。
- 启动恢复从 `serve.ts` 移到 `AgentRunner.start()`。它永不 reject：恢复失败进报告和
  日志，下一次启动再试；这和原来的启动行为一致。
- 测试从 server 搬到 agent。server 只保留 HTTP、store 适配器和传输层测试；agent 用
  假 store 和假 `buildAgent` 验证 enqueue → 起跑 → 落定。
- `运行器`、`暂停` 的词条从 `packages/server/GLOSSARY.md` 迁到
  `packages/agent/GLOSSARY.md`；`运行器` 不再 Avoid `worker` 之外的 `运行时`，
  因为 `AgentRunner` 不是 `AgentRuntime`。
- 运行器仍是单进程。收件箱、暂停和唤醒都在内存里；跨进程互斥不在这个决定的范围。
- `fork` 不是运行，但归运行器管。这是选“一个对象”的代价：`运行器` 的词义比
  `SessionRunner` 宽，换来一个入口。
