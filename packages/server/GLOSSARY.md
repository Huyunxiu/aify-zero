# Server

本机 API server：监听端口、校验凭据、托管 web 产物，并把 HTTP 与 WebSocket
两条通道交给浏览器和桌面。

## Language

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
