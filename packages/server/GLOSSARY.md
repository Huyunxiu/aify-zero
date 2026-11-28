# Server

The local API server: bots, settings, projects, session rows, and credentials; this layer also
defines providers and models. It listens on a port, checks credentials, hosts web assets, and
exposes HTTP and WebSocket channels to the browser and the desktop app.

## Language

**Bot**:
One persistent configured entity with its own identity, model preference, instructions, capability
set, Bot Home, and Bot Workspace. Every session belongs to one Bot.
_Avoid_: Agent, 智能体, 助手, 模板

**Default Bot (默认 Bot)**:
The built-in Bot that cannot be deleted. It owns sessions that did not select a custom Bot and
existing sessions after upgrade.
_Avoid_: 系统 Bot, 全局 Bot, 兜底 Bot

**Bot Home (Bot 主目录)**:
The private directory of one Bot under the data root (`~/.aify-zero/bots/<botId>/`). It holds the
file-based resources of that Bot.
_Avoid_: 系统目录, 配置目录, 操作系统目录

**Bot Workspace (Bot 工作目录)**:
The persistent cross-session working directory of one Bot, located by default at
`<botHome>/workspace`. It is the default `cwd` when no project is attached, and an extra read/write
root when a project is attached.
_Avoid_: 项目目录, 会话目录, 临时目录

**Asset (资源)**:
A file owned by one Bot or one session, kept under that owner's directory (`<ownerDir>/assets/`) and
served by the byte route `/api/asset`. Its deletion follows the owner's rule; it never outlives the
owner's file tree on its own.
_Avoid_: 静态资源, 上传文件, 附件, blob

**Session (会话)**:
One row in the list: a title, its owning Bot, an optional attached project, turns, one branch, and
the last activity; it is also where a run executes.
_Avoid_: 对话, 线程, chat, thread

**Delete Session (删除会话)**:
Make a session absent from every view while keeping its transcript: list and read endpoints treat it
as absent, and a trash view will handle it later. A running session cannot be deleted.
_Avoid_: 归档, 移除, 清空, 回收站

**Provider (供应商)**:
One party that provides model invocation service; it holds the API URL, protocol, and either the key
itself or the name of the environment variable that provides it. One provider can hold multiple
models.
_Avoid_: 提供商, 服务商, 渠道

**Provider Key (供应商密钥)**:
The credential a model call carries to its provider. It is either stored with the provider
(`apiKey`) or named by an environment variable (`apiKeyEnv`), and the name must sit inside the
`AIFY_PROVIDER_KEY_` namespace. The two are mutually exclusive. What is stored is the name, so a
settings read never returns the secret. The settings screen labels this field "API key"; this
document calls it a provider key because "API key" also names the Access Token.
_Avoid_: token, access token, secret key

**Model (模型)**:
One callable model offered by a provider. A model belongs to a provider and holds no access config.
_Avoid_: 模型配置, AI 模型

**Model Ref (模型引用)**:
A provider id plus a model id. Sessions, bots, and settings use it to identify a model uniquely
without joining strings.
_Avoid_: 模型标识, 完整模型名

**Model Id (模型 id)**:
The string an upstream provider uses to identify a model; it can contain `/`. It is not the same
thing as the display name in the UI.
_Avoid_: 上游模型名, wire 名

**API URL (API 地址)**:
The root URL of a provider service. The protocol picks the path that the SDK appends:
`/chat/completions` or `/responses`. The UI collects only the root URL, not the full endpoint.
_Avoid_: 基地址, 接口根地址, 服务地址

**Protocol (协议)**:
The request format that a provider accepts. One provider has one protocol only; if the same party
needs two protocols, configure two providers.
_Avoid_: 兼容类型, 接口类型

**Time Zone (时区)**:
The IANA name of the user's location, stored in user settings; when unset, it follows the host. A
calendar rule of a schedule freezes this value on itself at write time and does not follow setting
changes after that.
_Avoid_: 地区, 本地时间, UTC 偏移

**Access Token (访问令牌)**:
Machine-level credential that proves a request comes from the owner of this machine. The desktop
main process, CLI, and scripts use it.
_Avoid_: API key, 密钥, token

**Sign-in Session (登录态)**:
One credential that proves a browser's identity, stored in an HttpOnly cookie. It applies by host
name and page scripts cannot read it.
_Avoid_: 会话, session (confuses with agent sessions)

**Sign-in Ticket (登录票据)**:
One credential exchanged for a sign-in session; it appears only in the sign-in link. It binds to the
process run that issued it: it expires on restart and can be reused during that same run.
_Avoid_: 临时令牌, 验证码, magic link

**Trusted Origin Set (来源白名单)**:
Browser origins allowed to send a sign-in session. Browsers send cookies automatically, so a server
must check `Origin` to know which page sent a request.
_Avoid_: CORS 名单, 允许域名

**Ready Message (就绪消息)**:
The signal from the local API server reporting that it can serve requests, carrying the bound
listen address. The desktop app reads it to know where to forward requests; standalone runs do not
emit it and print only a listening line to the terminal.
_Avoid_: 就绪行, ready line, 握手行

**Last Activity (最后活动)**:
The moment a session's time refers to: when a turn starts or ends. Renaming and marking as read do
not count as activity; startup recovery, stale marker cleanup, and compaction do not count either.
It is not "the last time this row was written".
_Avoid_: 更新时间, 最后修改时间, 最近使用
