# MCP 授权方案

让远程 MCP 服务器（`http` / `sse`）支持 OAuth 授权：用户在设置页点一次「授权」，
浏览器里同意，令牌落到本地表，之后每回合照常装配工具。范围只到授权；resources、
prompts、sampling 不做。

## 决策

| 决策     | 结论                                                                                  |
| -------- | ------------------------------------------------------------------------------------- |
| 机制     | 配置里的 `auth` 三态：`none` / `headers` / `oauth`                                    |
| 协议     | 复用 `@ai-sdk/mcp` 的 `auth()` 与 `OAuthClientProvider`，只实现 provider 与持久化     |
| 适用传输 | 仅 `http` / `sse`；`stdio` 仍靠 `env`                                                 |
| 发起者   | 设置页点「授权」才开浏览器；后台撞 401 只标 `needs-auth`；会话里撞 401 返回错误文本   |
| 回调     | `http://127.0.0.1:<port>/api/mcp/oauth/callback`，挂在 `bearerAuth` 之前，见 ADR-0003 |
| 凭据     | `mcp_credential` 表，按 `(server_id, kind)` 分行，`generation` 列做条件删除           |
| 绑定     | 一条凭据属于一个服务器 id；URL / issuer 变化、删除服务器、切回静态凭据即丢弃          |
| 刷新     | 只靠 401 触发；不做主动刷新                                                           |
| 试连     | 「测试连接」只带已存令牌：不发起授权、不注册客户端、不覆盖 verifier                   |
| 失效清理 | 照 SDK 给的 scope；`invalid_client` 且动态注册的删全部，`invalid_grant` 只删令牌      |
| 授权完成 | 立刻连一次并刷新状态                                                                  |
| 撤销     | 授权过的行提供「撤销」，清掉令牌与注册信息                                            |
| 兼容     | 只支持动态注册；不开放手填 `client_id` / `secret` / scope                             |
| 信任     | `validateAuthorizationServerURL` 只放行 https 与回环                                  |

## 数据结构

```ts
// 配置里新增；缺省时按 headers 是否为空推断，已存设置不用迁移
type McpAuth = { type: "none" } | { type: "headers" } | { type: "oauth" };
```

```sql
-- mcp_credential：一行一次写入，generation 每次写加一
create table mcp_credential (
  server_id text not null,
  kind      text not null,      -- tokens | client | verifier
  generation integer not null default 0,
  content   text not null,      -- JSON
  created_at integer not null,
  updated_at integer not null,
  primary key (server_id, kind)
);
```

`tokens` 存 SDK 交回来的 `OAuthTokens` 原样：里面已经带了授权服务器的 pin
（`issuer` / `authorization_server` / `token_endpoint`），刷新时靠它判定「这份
令牌是不是同一个授权服务器发的」。`client` 存 `OAuthClientInformation`，`verifier`
存 `{ codeVerifier, state }`。

## 模块

| 路径                                                 | 职责                                                     |
| ---------------------------------------------------- | -------------------------------------------------------- |
| `packages/agent/src/mcp/oauth/store.ts`              | `McpCredentialStore` 接口与代次类型                      |
| `packages/agent/src/mcp/oauth/provider.ts`           | `OAuthClientProvider` 实现；捕获授权地址，不自己开浏览器 |
| `packages/agent/src/mcp/oauth/flows.ts`              | 进程内的待授权表：`state` → 配置快照，十分钟过期         |
| `packages/agent/src/mcp/oauth/authorize.ts`          | `completeMcpAuthorization()`：用授权码换令牌             |
| `packages/server/src/mcp/credentials.ts`             | 表读写实现与按服务器清理                                 |
| `packages/server/src/mcp/credentials-cleanup.ts`     | 配置变化后丢弃对不上的凭据                               |
| `packages/server/src/mcp/oauth.ts`                   | 把配置、存储、待授权表、回环地址拼成一个 provider        |
| `packages/server/src/mcp/oauth-callback.ts`          | 回调路由的处理与页面                                     |
| `packages/server/src/routers/mcp/mcp.router.ts`      | `authorize` / `revoke` 两个路由                          |
| `packages/ui/src/elements/settings/mcp-settings.tsx` | 授权方式选择、`needs-auth` 可点、撤销                    |

## 请求流

**点授权**：`mcp.authorize({ id })` → 管理器换代、建连 → 服务器返回 401 → 传输层
调 `auth()` → 发现元数据、动态注册、生成 PKCE → `redirectToAuthorization(url)` 把
地址留在 provider 上 → 抛 `UnauthorizedError` → 管理器收下地址、状态记 `needs-auth`
→ 路由把 `{ url }` 交给界面 → 界面 `window.open(url)`（桌面会被主进程转给系统浏览器）。

**回调**：浏览器带 `code` / `state` 到回环路由 → 从待授权表取配置快照 → 用同一个
回环地址重拼 provider → `auth({ authorizationCode, callbackState, callbackIssuer })`
→ 换令牌、写表 → 管理器换代重连 → 页面显示「可以回到应用」。

**运行期 401**：传输层先尝试用刷新令牌换一次；失败则 `auth()` 需要重新授权 → 抛
`UnauthorizedError` → 工具返回「授权已失效，请在设置页重新授权」→ 该服务器状态转
`needs-auth`。

**撤销**：删 `tokens` / `client` / `verifier` 三行 → 管理器换代 → 状态回 `idle`。

## 状态

`McpServerStatus` 从四个变五个，新增 `needs-auth`。它和 `failed` 分开：一个等用户
动手，一个等下次重试。`needs-auth` 是终态，不按时间重试：重试会重新发现元数据、
再注册一个客户端，而用户并没有授权。只有点授权、撤销或改配置才会换代。

## 安全

- 回调路由不读设置、不返回错误详情、不把授权码写进日志；`state` 一次性、十分钟过期。
- `validateAuthorizationServerURL` 拒绝非 https、非回环的授权服务器。
- 回调页只回一段静态文本，不渲染任何来自请求的内容。

## 分步实施

1. 文档与 schema：`auth` 字段、跨字段校验（`oauth` 只对远程生效）、`mcpAuthType()`。
2. 迁移：`mcp_credential` 表与仓储。
3. provider 与存储接口：令牌、注册信息、verifier 的读写，代次条件删除。
4. 连接与管理器：传 provider、识别 `UnauthorizedError`、`needs-auth`、`authorize()`、`revoke()`。
5. 回环回调：路由、待授权表、`completeAuthorization()`。
6. 设置页：授权方式选择、可点状态、撤销、i18n。
7. 测试：假授权服务器跑完整链路，另加代次删除与配置校验。

## 风险

- **回调不可达**：`attach` 远程 server 时回环地址不是用户的机器。界面提示在宿主机上授权。
- **并发刷新**：两个回合同时撞 401 会各刷一次。代次条件删除保证不会删掉别人刚存的新令牌，
  但可能多换一次令牌；接受。
- **明文存储**：令牌与 `apiKey` 一样明文落库。仓库没有钥匙串，另起一套只会让机密有两种编辑方式。
- **第三方服务器不合规**：不做手填 client 的后门；真遇到就退回 `headers` 档。
