# MCP 工具支持方案

让会话里的模型能用 MCP 服务器提供的工具。范围只到 tools：resources、prompts、
sampling 不做。

## 决策

| 决策       | 结论                                                                             |
| ---------- | -------------------------------------------------------------------------------- |
| 传输       | stdio 与 Streamable HTTP（SDK 的 `sse` 一并可用）                                |
| 配置位置   | `userSettings.mcpServers`，全局一份                                              |
| 连接归属   | 进程级共享，见 [ADR-0001](../adr/0001-mcp-connections-shared-across-sessions.md) |
| 代码落点   | `packages/agent`，配置由宿主注入                                                 |
| 工具名     | `服务器名__工具名`                                                               |
| 暴露策略   | 全量注册，不懒加载                                                               |
| 审批默认   | 只读注解自动放行，其余 ask；`destructiveHint` 永远 ask                           |
| 连接失败   | 会话照常启动，缺工具，状态进设置页                                               |
| 结果内容   | 只交 text 与 structuredContent；超过 256 KB 截断                                 |
| 配置生效   | 下个回合重连，不打断进行中的回合                                                 |
| 服务器说明 | 只用工具说明，不用服务器的 `instructions`                                        |

## 依赖

`@ai-sdk/mcp` 已在 `node_modules`（传递依赖），没有声明。要加进 catalog 与
`packages/agent/package.json`。同时补上 `zod` 的声明：现有工具已经在 import 它，
只是没写进 `dependencies`。

## 数据结构

```ts
type McpServerConfig = {
  id: string; // 稳定 id，改名不变
  name: string; // 工具名前缀，唯一，[a-z0-9_-]
  enabled: boolean;
  autoApprove: boolean;
  transport:
    | {
        type: "stdio";
        command: string;
        args: string[];
        env: Record<string, string>;
        cwd?: string;
      }
    | { type: "http"; url: string; headers: Record<string, string> };
};
```

`transport` 用判别联合，避免 stdio 和 http 的字段互串。schema 写在
`packages/agent/src/mcp/config.ts`，由 `settings.schema.ts` 直接引用，保证一份定义。

## 模块

| 路径                                                       | 职责                                                                              |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `packages/agent/src/mcp/config.ts`                         | `McpServerConfig` 的 zod schema 与默认值                                          |
| `packages/agent/src/mcp/connection.ts`                     | 一个服务器：建连、握手、列工具、调用、关闭、初始化超时                            |
| `packages/agent/src/mcp/manager.ts`                        | 进程级管理器：懒连接、租约式引用计数、状态表、空闲 5 分钟断开、失败缓存、配置失效 |
| `packages/agent/src/mcp/tool.ts`                           | 把 MCP 工具包成本地工具：加前缀、读注解、规范化结果、截断                         |
| `packages/agent/src/extensions/mcp.ts`                     | `McpExtension`：`init` 里借租约并注册工具，`dispose` 只归还引用                   |
| `packages/server/src/mcp/registry.ts`                      | 管理器单例、从设置读取配置、保存设置后失效                                        |
| `packages/server/src/session/agent.ts`                     | 把配置与单例传给 `createSessionAgent` 的 `extensions`                             |
| `packages/server/src/serve.ts`                             | shutdown 时关闭管理器，收掉子进程                                                 |
| `packages/server/src/routers/settings/settings.schema.ts`  | `mcpServers` 字段                                                                 |
| `packages/server/src/routers/settings/settings.service.ts` | 保存前查重名/重 id，保存后调用 `invalidate()`                                     |

## 请求流

**保存配置**：`setting.update` 写 `dict` 表 → 调用管理器 `invalidate()`（不主动断开，
只标记）→ UI 刷新状态。

**新回合**：`buildSessionAgent` 读设置 → `new McpExtension({ manager, servers })` →
`init` 对每个 `enabled` 的服务器 `manager.acquire(server)` → 拿到租约（`{ status, tools }`
加 `callTool` 与 `release`）→ 把成功的工具以 `name__tool` 注册。失败只记状态，不抛错；
失败的服务器也拿到租约，归还路径因此只有一条。

**工具调用**：`step-runner` 剥掉 `execute` 发起流式调用 → 模型返回工具调用 → 整批
走 `pre_tool_call` 与审批 → `executeToolCalls` 执行包装后的工具 → 租约的 `callTool()`
→ `CallToolResult` → `ToolOutput`。

## 审批规则

| 注解                    | `autoApprove` 关 | `autoApprove` 开 |
| ----------------------- | ---------------- | ---------------- |
| `readOnlyHint: true`    | 放行             | 放行             |
| 无注解                  | 询问             | 放行             |
| `destructiveHint: true` | 询问             | 询问             |

注解是第三方自述，按不可信处理；缺省当破坏性。

## 工具名与冲突

`${server.name}__${tool.name}`。服务器名在保存时校验唯一性与字符集，所以前缀不会
产生歧义。同名工具由注册后的重名检查拒绝，记日志并跳过，不影响其它工具。

## 结果映射

- `content` 里的 text 与 `structuredContent` 交给模型。
- image、resource 等二进制降级成一行说明（类型 + 大小）。`metadata` 只留类型、
  MIME 和字节数：把 base64 原文存进 SQLite 会让每一步都背上几百 KB。
- 单次结果超过 256 KB 截断，末尾附「已截断，请缩小参数范围」。
- `isError` 为真时返回 `code: "error"`，错误文本给模型看。

## UI

**设置页**：`settings.tsx` 的 `nav` 加第 4 项「MCP 服务器」，内容照
`model-settings.tsx`：列表 + Switch 启停 + Pencil 编辑 + Trash 二次确认 + 同一个
Dialog 复用新增/编辑。每行显示状态点、工具数、失败原因。编辑弹窗里有「测试连接」。
`env` 与 `headers` 按行编辑，明文存 `dict`（与现有 `apiKey` 一致，它也是普通输入框）。

**会话面板**：`assistant-message.tsx` 的 if 链加兜底分支，任何未匹配的工具都渲染成
通用面板（图标 + 工具名 + INPUT/OUTPUT + 审批按钮）。MCP 工具走这个面板，多一个
服务器名徽标。

**文案**：走 `common.json` 的 `settings.*`，en-US 与 zh-CN 都补。

## 分步实施

1. 依赖与 schema：catalog、`packages/agent/package.json`、`config.ts`、设置 schema。
   验证：`vp check` 过，设置能存能取。
2. 连接与工具包装：`connection.ts`、`tool.ts`。验证：内存 transport 单测覆盖握手、
   列工具、调用、结果映射、截断、注解映射。
3. 管理器：`manager.ts`，含引用计数、空闲断开、失败缓存、失效。验证：单测用假时钟。
4. 接线：`McpExtension`、服务端单例、`buildSessionAgent` 传参、shutdown 清理。
   验证：一个 stdio 冒烟测试，起真子进程并确认退出时被杀。
5. 设置页：nav 项、列表、编辑 Dialog、测试连接、i18n。
6. 面板渲染：兜底分支、MCP 面板、审批按钮。

前 4 步不碰 UI，可以独立合并；5、6 可并行。

## 风险

- **子进程泄漏**：shutdown、异常退出、单个服务器建连失败都要收。管理器在进程 exit
  时无法保证清理，所以只在 `serve.ts` 的正常关闭路径上做，并给子进程设超时 kill。
- **每回合重复注册**：工具快照来自管理器缓存，`init` 只同步注册，不重连。
- **上下文膨胀**：全量注册意味着工具数直接进提示词。状态行显示每个服务器的工具数，
  超过 50 给提示，但不自动禁用。
- **第三方文案**：工具描述原样进提示词，不可控。v1 接受。

## 实施记录

已经落地的部分与上面的差异：

- 传输多了 `sse`：SDK 的远程配置本来就同时支持 `http` 与 `sse`，只是配置里的一个取值。
- 二进制内容的原文没有进 `metadata`，只留类型、MIME 和字节数。原计划写的是「原文进
  metadata」，那会把 base64 写进每一步的存储。
- 引用计数记在租约上，不记在服务器 id 上：配置一改，旧连接会被新的一代取代，
  但旧租约还在进行中的回合手里，按 id 归还会把这次归还算到新连接头上。旧的一代
  等最后一个 `release` 再断开，`invalidate()` 也不再清空工具表，否则正在跑的
  回合会撞上 `not connected`，审批还会因为查不到注解而弃权放行。
- 服务器名除了字符集，还拒绝 `__` 与结尾 `_`：它们会和工具名分隔符混淆，
  切分拿到错误的服务器名，审批就查不到注解。
- 重名与重 id 在保存设置时拦住（`MCP_SERVER_DUPLICATE`），弹窗里也先校验一次重名；
  `config.ts` 的 `findMcpServerProblems` 因此有了 src 里的调用点，不再只是测试在用。
- `env` 与 `headers` 没有做成密码框：仓库里 `apiKey` 也是普通输入框，单独给这两个
  字段加遮罩会让同一类机密有两种编辑方式；它们在列表里不显示，只在编辑弹窗里出现。
- 结果只按 256 KB 截断，没有另加行数上限：行数被字节数自然约束，再加一条只会让
  截断提示说错原因。
- `ensureUserSettings` 现在对读到的设置跑一遍 schema。新增字段的默认值只在这里补，
  否则旧设置里没有 `mcpServers`，调用点得到 `undefined`。
- 冒烟测试自带一个 stdio 服务器（`tests/mcp/fixtures/echo-server.mjs`，约 80 行），
  不额外引入依赖。

## 不做

resources、prompts、sampling；OAuth；`tools/list_changed` 监听；单工具级开关；
按项目或按 agent 的配置；MCP 工具结果的富媒体回灌模型。
