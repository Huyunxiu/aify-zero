# 桌面外壳与 API

应用怎么跑起来：谁监听端口、桌面什么时候自己起 server、浏览器怎么登录、迁移在
哪应用。日常的启动命令见根目录 [README](../../README.md)。

## 文档源

打包后的应用加载 `aify-app://app/`。Electron 的 `protocol.handle` 处理器从
磁盘提供构建后的渲染器文件，并把 `/api` 命名空间转发到 API server（一个真实的
HTTP 源）。开发模式下它把文档请求代理到 Vite，HMR 继续工作。
`AIFY_APP_PROTOCOL=0` 直接加载 Vite URL，这是排障用的口子。

## API server 模式

API 位于 `apps/server`（`@workspace/server-app`），是唯一的监听者。桌面端通过
`AIFY_SERVER_MODE` 在三种模式中选择一种：

| 模式           | 行为                                                                                                                                                                          |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auto`（默认） | 设了 `AIFY_API_ORIGIN` 就用它；否则探测 `AIFY_API_HOST:AIFY_API_PORT`（默认 `127.0.0.1:18086`，开发期短暂重试），有 server 应答 `GET /health` 就接上去；否则启动内置 server。 |
| `owned`        | 始终在 `utilityProcess` 里启动内置 server（`.vite/build/server-entry.js`）；该模式下 `AIFY_API_ORIGIN` 被忽略。                                                               |
| `attach`       | 从不启动内置 server；要求 `AIFY_API_ORIGIN` 或默认源上存在外部 server。                                                                                                       |

内置 server 默认用系统分配的端口，因为渲染端始终经主进程转发；主进程从子进程
经 `process.parentPort` 发来的就绪消息里拿到实际端口。设 `AIFY_API_PORT` 才会
强制固定端口。`AIFY_APP_PROTOCOL=0` 需要固定的 `AIFY_API_PORT`（或
`AIFY_API_ORIGIN`），因为 Vite 代理在 server 启动前就配好了。

渲染窗口会在内置 server 还在启动时显示。`aify-app://` handler 把这段时间的
API 请求挂起，等 server ready 后再转发；确实不可用时才返回带 `retry-after` 的
`503`。ready 之后意外退出的内置 server 会按退避最多重启 3 次；这段窗口期里的
瞬时 503 会被 query client 重试几秒。主进程还向渲染端推送 `server-status`，
启动/重连期间显示一个小状态条。

## 登录与凭据

浏览器用链接登录。server 每次启动都会打印
`[auth] sign in: http://…/?token=…`。地址就是应用本身：页面把 token 交给
`/api/auth/login`，拿到 HttpOnly 的 `aify_session` cookie，然后把 token 从
地址栏抹掉。之后的请求、`<img src>` 和 WebSocket 握手都会自动带上这个 cookie。
token 不按时间过期：重启 server 之前一直可用，也可以给多台设备用；登录态三十天
有效，使用中续期。已登录页面的「设置 → 通用」可以再生成一条链接，对应
`POST /api/auth/login-link`。

机器客户端用 `Authorization: Bearer <token>`：桌面主进程在转发
`aify-app://` 请求时注入，渲染端永远看不到令牌；CLI 同理。令牌优先取
`AIFY_API_TOKEN`，未设置时读取 `~/.aify-zero/api-token`（首次启动 server 时
以 `0600` 创建）。`dev:web` 的 Vite 代理只做转发，不再注入令牌。

## 远程访问

前端产物存在时（`apps/web/dist` 或 `AIFY_WEB_ROOT`），server 从 `/` 托管它，
远程访问因此同源，不需要 CORS。远程部署要设置 `AIFY_PUBLIC_ORIGIN`：它决定
打印链接的主机名，也决定 cookie 是否加 `Secure`。页面由单独的开发服务器提供
时，设置 `AIFY_WEB_ORIGIN`。局域网明文 http 可用，但票据和 cookie 会明文
过网；不可信网络请上 HTTPS。

## 单实例与切换 server

桌面端同时只允许一个实例：再次启动只会聚焦已有窗口，不会另起一套 server，也
不会打开同一个数据库。要把正在运行的桌面端从内置服务器迁移走，可在渲染器或
DevTools 中调用 `aifyDesktop.useServer("http://127.0.0.1:18086")`：主进程会
校验 `/health`、停止归自己所有的子进程、切换 `aify-app://` 转发器并重新加载
页面。运行期切换只接受回环地址；远程 server 必须在启动前通过
`AIFY_API_ORIGIN` + `AIFY_API_TOKEN` 配置。

## 迁移

迁移文件是表结构的唯一来源，每次启动 server 都会应用它们。打包后的应用基于
`Resources/migrations` 中随包携带的迁移（见 `packagerConfig.extraResource`）
迁移 `~/.aify-zero/aify-zero.db`；`dev:server`、`dev:desktop` 和独立打包的
`apps/server` 迁移当前 checkout 的 `local.db`，每个 worktree 各有一份。迁移
失败会中止启动，不会在结构漂移的库上提供服务。

因此改 schema 就要有迁移：运行 `vp run db:generate`，检查生成的 SQL 并提交。
`vp run ready` 会跑 `db:check`，schema 改了却没生成迁移时它会失败。有表但没有
迁移历史的库无法启动——它是这条规则之前建的：运行一次
`vp run db:baseline`，把已有结构标记为已应用而不重放 SQL，或者删掉文件让启动
过程重建。drizzle 的几个命令（`db:baseline`、`db:migrate`、`db:studio`）默认
操作 checkout 的 `local.db`；要操作别的库用 `DATABASE_URL` 指过去。

## 环境变量

环境变量由进程入口加载，而不是由库模块加载：`apps/server` 依次读取
`apps/server/.env` 和仓库根目录的 `.env`，桌面端则把自己的环境变量传给内置
子进程。因此 `.env` 中的相对路径 `DATABASE_URL` 会相对于进程的工作目录解析
——建议使用绝对路径或默认值。
