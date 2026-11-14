# Server

本机 API server：设置、项目、会话行和凭据，供应商与模型的配置也定义在这一层。
它监听端口、校验凭据、托管 web 产物，把 HTTP 与 WebSocket 两条通道交给浏览器
和桌面。

## Language

**供应商 (Provider)**:
提供模型调用服务的一方，持有 API 地址、协议和密钥。一个供应商下可以有多个模型。
_Avoid_: 提供商、服务商、渠道

**模型 (Model)**:
供应商提供的一个可调用模型。模型属于一个供应商，不持有接入信息。
_Avoid_: 模型配置、AI 模型

**模型引用 (Model Ref)**:
供应商 id 加模型 id。会话和设置用它唯一确定一个模型，不用拼接字符串。
_Avoid_: 模型标识、完整模型名

**模型 id (Model Id)**:
供应商上游用来标识模型的字符串，可以自带 `/`。它和界面上的显示名不是一回事。
_Avoid_: 上游模型名、wire 名

**API 地址 (API URL)**:
供应商服务的根地址。协议决定 SDK 在它后面追加的路径：`/chat/completions` 或
`/responses`。界面只填根地址，不填完整端点。
_Avoid_: 基地址、接口根地址、服务地址

**协议 (Protocol)**:
供应商接受的请求格式。一个供应商只有一种协议；同一家要用两种就配两条。
_Avoid_: 兼容类型、接口类型

**访问令牌 (Access Token)**:
机器级凭据，证明请求来自这台机器的拥有者。桌面主进程、CLI 和脚本用它。
_Avoid_: API key、密钥、token

**登录态 (Sign-in Session)**:
浏览器证明自己身份的一段凭据，放在 HttpOnly cookie 里。它按主机名生效，页面
脚本读不到。
_Avoid_: 会话、session（会和 agent 会话混淆）

**登录票据 (Sign-in Ticket)**:
用来换一条登录态的凭据，只出现在登录链接里。它绑定在签发它的那次进程运行上：
重启后失效，同一次运行里可以重复使用。
_Avoid_: 临时令牌、验证码、magic link

**来源白名单 (Trusted Origin Set)**:
允许携带登录态的浏览器源。cookie 会被浏览器自动带上，所以判断请求来自哪个
页面只能看 `Origin`。
_Avoid_: CORS 名单、允许域名
