# MCP 工具的审批规则放在宿主审批函数里，不放在 `pre_tool_call`

`createMcpToolApprovalPattern` 返回一个 `ToolApprovalPattern`，由 `packages/server`
挂到 `createSessionAgent` 的 `toolApprovalPattern` 上。`McpExtension` 注册工具，但
不注册审批 hook。

原因是子会话的继承方式：`createSubagent` 只复制父的 `agent.tools` 和
`toolApprovalPattern`，不复制扩展注册的 hook（见 `subagent/create.ts`）。审批若
写在 `pre_tool_call` 里，子会话里没有这个 handler，MCP 工具就会在没有任何决策的
情况下直接放行 —— 破坏性工具也不问。

代价：审批规则和工具注册分在两层。`McpExtension` 负责「有什么工具」，宿主函数
负责「能不能调」。两者共用同一个管理器，所以规则仍然只看工具名就能拿到注解。

## Consequences

- `resolveTool` 必须在工具被调用时能查到注解：它查的是管理器里已连上的工具表，
  而工具表在装配时已经填好。
- 以后要加别的审批来源（例如项目级白名单），也只能加在宿主的组合函数里，不能
  指望扩展的 hook。
