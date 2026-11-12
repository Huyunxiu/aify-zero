# 工具目录方案

MCP 服务器一多，每步请求都要背上一整排工具的 schema。这个方案把 MCP 工具挪出
声明集，让模型用搜索拿到工具名和参数，再用一个转调工具去调。范围只到工具：技能、
子代理、内置工具都不进目录。

## 决策

| 决策       | 结论                                                                                                  |
| ---------- | ----------------------------------------------------------------------------------------------------- |
| 解决什么   | 上下文预算。验收指标是每步请求的工具数与 schema token 数，不看主观准确率                              |
| 收哪些     | 只收 MCP 工具。内置工具、技能、子代理永远常驻                                                         |
| 形态       | 转调。搜到的工具**不进**声明集，见 [ADR-0004](../adr/0004-tool-catalog-routes-rather-than-injects.md) |
| 排序       | 关键词分级；支持 `"服务器名__"` 前缀查询；不用向量、不用 BM25                                         |
| 开关       | 按服务器声明，`exposure` 缺省为 `deferred`。没有总数阈值                                              |
| 结果内容   | 名字 + 一行说明 + 紧凑参数签名 + `unavailable`                                                        |
| 审批       | 穿透到真实工具名。审批、hook、事件看到 `server__tool`                                                 |
| 历史与 UI  | 历史留转调名。UI 从入参取真实名，复用现有兜底渲染                                                     |
| 子代理     | 继承父的暴露方式快照，不重新发现                                                                      |
| 逃生口     | 只到服务器粒度                                                                                        |
| 服务器缺失 | 不等待。装配时没就绪的服务器进 `unavailable`                                                          |

## 与 mcp-tools.md 的关系

[mcp-tools.md](./mcp-tools.md) 原来的「暴露策略：全量注册，不懒加载」由本方案取代。
注册方式不变，变的只是「哪些工具被声明给模型」。

## 数据结构

暴露方式是注册期的标记，不是新的可变状态：

```ts
// packages/agent/src/extensions/types.ts
type ToolExposure = "direct" | "deferred";

tool(name: string, tool: Tool, options?: { override?: boolean; exposure?: ToolExposure }): void;
```

`direct` 是缺省值。目录成员关系因此仍从 `Agent.tools` 现算，不另建注册表
（`Agent.tools` 是唯一来源，见 `agents.ts:80`）。

服务器侧只加一个字段，默认值放在读取处，和 `auth` 同一套做法：

```ts
// packages/agent/src/mcp/config.ts
exposure: z.enum(["direct", "deferred"]).optional(),

export function mcpExposureType(server: McpServerConfig): McpExposure {
  return server.exposure ?? "deferred";
}
```

旧设置里没有这个字段，读出来就是 `deferred`，不需要迁移数据。`codemode` 这类取值
现在不写进类型：写进去但跑不了，只会让设置文件能存不能跑；以后加是纯追加。

`AgentToolSet` 补两个键：`"search-tools"`、`"call-tool"`。

## 模块

| 路径                                                    | 职责                                                  |
| ------------------------------------------------------- | ----------------------------------------------------- |
| `packages/agent/src/tool-catalog/catalog.ts`            | 从 `ToolSet` 与暴露方式构建条目，含紧凑参数签名的渲染 |
| `packages/agent/src/tool-catalog/rank.ts`               | 五档关键词排序与 `__` 前缀查询                        |
| `packages/agent/src/tools/search-tools.ts`              | `search-tools`：查询目录，返回条目与 `unavailable`    |
| `packages/agent/src/tools/call-tool.ts`                 | `call-tool`：按名字转调，schema 校验由执行层负责      |
| `packages/agent/src/extensions/builtin/tool-catalog.ts` | 注册两个工具与提示片段，读取 `unavailable` 能力       |
| `packages/agent/src/extensions/types.ts`                | `ToolExposure` 与 `api.tool` 的 `exposure` 选项       |
| `packages/agent/src/extensions/manager.ts`              | 记下每个工具的暴露方式，随工具一起移除                |
| `packages/agent/src/agents.ts`                          | 暴露方式表跟着 `tools` 走，供子代理快照               |
| `packages/agent/src/tools/execution.ts`                 | 声明集过滤；转调的目标解析与审批穿透                  |
| `packages/agent/src/extensions/mcp.ts`                  | 按服务器的 `exposure` 注册 MCP 工具                   |
| `packages/agent/src/mcp/config.ts`                      | 服务器 schema 的 `exposure` 字段                      |
| `packages/agent/src/subagent/create.ts`                 | 子代理继承暴露方式快照                                |
| `packages/ui/src/components/assistant-message.tsx`      | 转调调用的渲染分支                                    |
| `packages/ui/src/components/settings/mcp-settings.tsx`  | 每行的暴露方式开关                                    |

## 请求流

**装配**：`McpExtension.init` 借租约 → 按 `server.exposure` 注册工具 →
`ToolCatalogExtension.init` 注册 `search-tools` 与 `call-tool`，并挂提示片段。

**每步调用模型**：`step-runner.ts:335` 从 `stripToolExecution(tools)` 改成先按暴露
方式过滤，只把 `direct` 的工具交给 SDK。`deferred` 工具仍留在 `Agent.tools` 里，
执行时照旧查得到。

**搜索**：模型调 `search-tools({ query, limit })` → 从 `Agent.tools` 里取
`deferred` 条目 → 排序 → 返回名字、说明、签名。`"服务器名__"` 命中前缀时只在该
服务器里搜，不进排序。

**转调**：模型调 `call-tool({ name, input })` → `execution.ts` 在 `planToolCall`
之前解析目标 → hook 与审批收到真实工具名和真实入参 → 执行真实工具 → 结果按原
`toolCallId` 和原名 `call-tool` 写回。

## 转调与审批

`runToolCall` 现在只用 `plan.toolCall` 一处信息做三件事：查工具、发事件、写结果。
转调把这三件事拆成两半：

| 用途                     | 用哪个名字             |
| ------------------------ | ---------------------- |
| 查工具、跑 `execute`     | 真实工具名             |
| `pre_tool_call`、审批    | 真实工具名             |
| `tool.result` 等事件     | 原调用名，入参里有真名 |
| 写回模型的 `tool-result` | 原调用名               |

结果部分必须留原名：`tool-result` 的 `toolName` 要和助手消息里的工具调用对得上，
改写在 provider 侧不可靠。这条和 eve 的做法一致。

解析点做成执行层的一个可选函数：`executeToolCalls({ resolveCallTarget })`，缺省是
恒等。目录扩展不参与执行，所以 `execution.ts` 不需要认识 `call-tool` 这个名字。

解析函数挂在工具注册上：`api.tool("call-tool", tool, { resolveCall })`，由 `Agent`
存进 `toolRoute`，`StepRunner` 执行前按名字查一次。它**不是** capability：子会话
复制工具集、但不跑扩展，挂在扩展或 capability 上的东西在子会话里一律消失，转调
入口就变成「工具在册、声明集里没有、也调不动」的空壳——`toolRoute` 和
`toolExposure` 一样跟着工具集走。`call-tool` 仍然留一个 `execute`，但它只在输入
解析不出真实工具时运行，唯一作用是告诉模型「先搜」。

审批因此不用改：`mcp/approval.ts` 只看名字解析服务器与注解，它收到的是真实名。

## 搜索与排序

五档，先命中先得：精确工具名 → `__` 后的精确工具名 → 服务器名 → 名字前缀 →
说明里的关键词。同一档内按命中词数降序，再按名字字典序，结果稳定可复现。

签名只给参数名和类型，不展开嵌套 schema，超过 400 字截断。转调方案里这是模型拼
出正确 `input` 的唯一信息源，所以必须有；但给完整 JSON Schema 等于把省下的 token
还回去。

`unavailable` 列出装配时没就绪的服务器与原因。**没有等待逻辑**：`McpExtension` 在
装配时一次性注册，之后不重新发现（见 mcp-tools.md 的实施记录），所以不存在「稍后
才到」的工具。参考实现需要等待，是因为它们会在会话进行中重新列工具。

## 提示片段

`instructionsSection` 追加一段，列出启用了目录的服务器名与各自工具数，上限 20 条，
超出折叠成一行计数。只给服务器名，不给工具名：给了就随工具数增长，把省下的 token
又花回去。

## UI

- **会话面板**：`assistant-message.tsx` 的兜底分支加一个判断——工具名是 `call-tool`
  时，标题写成入参里的 `服务器名 · 工具名`，下面复用现有 INPUT/OUTPUT 骨架。
- **设置页**：MCP 每行加一个「暴露方式」开关（常驻 / 按需搜索），保存时写进
  `settings.mcpServers`。`mcp-settings.tsx:238` 的 `MANY_TOOLS = 50` 改成按目录里的
  工具数计算，不再和「多少才算多」的提示各用一套数。
- **文案**：`common.json` 的 `settings.*`，en-US 与 zh-CN 都补。

## 分步实施

1. **暴露方式登记**：`ToolExposure`、`api.tool` 的选项、`manager.ts` 的记录、
   `agents.ts` 的暴露方式表、`subagent/create.ts` 的快照继承。
   验证：`tests/extensions.test.ts` 覆盖缺省 `direct`、重名覆盖时的暴露方式、
   子代理继承。
2. **声明集过滤**：`execution.ts` 的 `declaredTools` 与 `step-runner.ts` 的调用点。
   验证：`tests/tools/execution.test.ts` 断言 `declaredTools` 只留常驻工具、真实
   工具集里 `deferred` 工具仍可执行；`tests/agent-factory.test.ts` 断言装好的
   agent 里 `deferred` 工具仍在册、也仍在目录里。
3. **目录与排序**：`catalog.ts`、`rank.ts`，纯函数。
   验证：新 `tests/tool-catalog/rank.test.ts` 覆盖五档顺序、前缀查询、稳定性、截断。
4. **两个工具**：`search-tools.ts`、`call-tool.ts`、扩展与提示片段。
   验证：`tests/tool-catalog/extension.test.ts` 断言结果的形状、`remaining`、
   `catalogSize`，`unavailable` 出现与不出现两种情况，以及没有目录时提示片段
   一个字都不加。
5. **转调穿透**：`api.tool` 的 `resolveCall`、`Agent.toolRoute`、`execution.ts`
   的目标解析。
   验证：`tests/tools/execution.test.ts` 断言 hook 与审批收到真实工具名、事件与
   写回模型的结果仍是原名、真实工具一次都没跑（入参被拒时）、schema 默认值被补上、
   MCP 的 JSON Schema 原样通过。
6. **MCP 接线**：`config.ts` 的字段、`extensions/mcp.ts` 传 `exposure`、旧设置缺省。
   验证：`tests/mcp/config.test.ts` 缺字段读成 `deferred`；`extension.test.ts` 两种
   暴露方式各注册一次。
7. **UI**：兜底分支、设置页开关、`MANY_TOOLS` 口径、i18n。

1 到 6 不碰 UI，可以独立合并；7 单独一段。

## 风险

- **模型拼错 `input`**：转调没有「下次请求就能看到真 schema」这条后路，签名和校验
  错误文本是唯一补救。签名必须准，校验错误要指出哪个参数不对。
- **转调成为万能入口**：`call-tool` 接受任何存在的工具名，所以审批穿透是它安全的
  前提，不能省。
- **历史里认不出调了什么**：转调调用在历史里只有 `call-tool` 加一段入参。恢复会话
  后模型能看到入参，人看不到——所以 UI 必须渲染真实名。
- **服务器删除后悬空**：转调按名字查 `Agent.tools`，查不到就是明确的错误，不会像
  「已注入但未卸载」那样留下调不通的工具。
- **提示片段与工具数不同步**：片段在装配时拼好，服务器变化要等下个回合。

## 不做

按工具粒度的暴露方式；`codemode` 或脚本式工具访问；把技能、子代理、内置工具收进
目录；向量或 BM25 召回；工具列表变化的增量投递（不做 provider 特化）；跨服务器的
工具重名重排。

## 实施记录

已经落地的部分与上面的差异，以及写代码时才发现的事：

- **`exposure` 的默认值放在读取处**，不用 zod `.default()`：`.default()` 会让
  `McpServerConfig` 的输出类型必须有这个字段，所有直接构造配置的测试都要补，
  而且和 `auth` 的既有做法不一致。改成可选字段加 `mcpExposureType()`。
- **`api.optional`**：目录要问「哪些服务器的工具不在里面」，而这个问题只有 MCP
  扩展能回答。用 `use` 会在没有 MCP 的会话里抛错，所以给 `ExtensionAPI` 加了一个
  和内核 `capability()` 同义的 `optional`。
- **转调解析从 capability 挪到了工具注册上**：第一版用 `Capabilities.callTarget`，
  编译、单测都过，但子会话不跑扩展，这个能力在子 agent 里恒为 undefined——父身上
  进目录的 MCP 工具在子代理里既不在声明集、也调不动，等于子代理完全没有 MCP。
  这是「能力总线只属于装配它的那个会话」这条边界在说话，不是接线漏了。解析函数
  改成注册选项 `resolveCall`，`Agent.toolRoute` 存一份，子代理按存活工具名过滤后
  继承（`restrictToTools`，和 `toolExposure` 同一套规则）。
- **提示词与工具说明改成短句**：模型的说明按 ASD-STE100 写，一句一个意思，不再一句
  串三件事（`search-tools`、`call-tool`、提示片段三处）。
- **`searched` 改名 `catalogSize`**：它报的是目录总数，可是走 `"服务器__"` 前缀查询
  时只扫了一台服务器，叫 `searched` 就是假的。改名之后它只说真话：目录里有多少
  工具。
- **转调的入参现在真的校验了**：`runExecute` 之前没有任何 schema 校验——`executeTool`
  只接收 `InferToolInput`，服务端校验的是模型发出的那个外壳。现在路由来的调用先按
  真实工具的 schema 过一遍，默认值也在这里补上，校验失败的那句话写明工具名和参数名。
  边界要说清楚：**MCP 工具仍然不本地校验**。它带的是服务器给的 JSON Schema，这个
  SDK 的 `jsonSchema()` 不提供校验器，入参原样送到服务器，由服务器拒绝，错误文本再
  回到模型。有一条测试把这个边界钉住，免得以后有人以为全都校验了。
- **工具名的解析只有一处**：`catalog.ts` 的 `NAME_SEPARATOR` 加上 `namespaceOf` /
  `bareNameOf` / `queryNamespace`。`rank.ts` 原本自己写 `endsWith("__")`、
  `slice(0, -2)`、`slice(at + 2)`，分隔符一变就静默错，而且 `±2` 没有类型能兜。
- **`searchCatalog` 只排序，不截断**：截断和 `remaining` 由 `search-tools` 一处
  负责。原来两边都能截，一旦调用方传了 `limit`，`remaining` 会按已截断的数组再减。
- **删掉 `ToolExposureMap` 和 `McpExposure` 两个别名**：前者零使用，后者是
  `ToolExposure` 的第二个名字；两者都在同一套概念上多起了一个名。
- **`call-tool` 的注册用 `CALL_TOOL_NAME`**：常量本来就有（解析函数要用），注册处
  手写字面量会让两处漂开。
- **`bareNameOf` 不再用 `lastIndexOf("__") + 2`**：名字里没有分隔符时 `lastIndexOf`
  返回 -1，`slice(1)` 得到「去掉首字母的名字」，于是任何「少一个字母」的查询都走
  第二档命中，排在真正以它作命名空间的服务器前面。改成 `indexOf`，没有分隔符就返回
  整个名字。
- **`call-tool` 保留 `execute`**：原本打算不写，但输入解析不出来时执行层会报
  「没有可执行的工具 call-tool」，模型读不懂。留一个抛错的分支，错误文本直接说
  「先跑 search-tools」。
- **两个工具的输出走 `ToolOutput`**：仓库里每个工具的返回值都是
  `{ output, code, metadata? }`，UI 的 `part.output.code` 依赖它。照这个形状写，
  `tool-step.tsx` 的收窄逻辑不用改。
- **`tool-step.tsx` 的 switch 要显式加两个 case**：开关有 `default`，但仓库的
  穷尽性规则不认 `default`，`AgentToolSet` 多两个键就报错。两行占位，摘要返回
  `undefined`。
- **`Agent` 的 `registerTool` 适配器丢过第三个参数**：`registerTool: (name, tool)
=> this.registerTool(name, tool)` 编译得过（少一个参数是合法的），但 `exposure`
  在这里被吞掉，所有工具都成了 `direct`。`tests/agent-factory.test.ts` 里那条
  「deferred 工具仍在册、但不在目录外的声明集里」的测试就是为这个写的——它当场
  抓到了。
- **`unavailable` 不等待服务器**：装配时一次性注册之后不会再
  发现工具，参考实现需要等待是因为它们会在会话进行中重新列工具。
- **`unavailable` 由 MCP 扩展提供**：装配时没就绪的服务器只有它知道。它
  `provide(Capabilities.catalogUnavailable, …)`，目录扩展用 `optional` 读——没有
  MCP 的会话没有这个能力，那不是错误。
- **`MANY_TOOLS` 改名并收窄**：它原来讲的是「这些工具每步都进提示词」，而现在
  只有 `direct` 的服务器才这样。改名 `MANY_RESIDENT_TOOLS`，并且只在
  `exposure` 是 `direct` 时提示——进目录的服务器工具再多也不占每步请求。
- **设置页开关是布尔**：表单里存 `searchOnDemand`，进出表单时和 `exposure` 互转。
  直接放一个三态字符串控件会让「开关」这个词名不副实。
