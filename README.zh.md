# Aify Zero

> 中文副本。以 [`README.md`](./README.md) 为准。

仓库里有 `apps/desktop`（Electron 外壳）、`apps/server`（API）和 `apps/web`
（浏览器 UI）；`packages/` 放 UI、agent、server、数据库和沙箱的代码。

## 准备

安装 Vite+ 命令行工具：

```bash
curl -fsSL https://vite.plus | bash
```

开一个新终端。`vp` 会按 `.node-version` 装 Node.js，按 `packageManager` 装
pnpm，这两样都不用自己装。

环境不对劲时跑 `vp env doctor`。

## 安装依赖

```bash
vp install
```

拉过代码之后也要跑一次。

## 启动开发环境

| 命令                 | 启动什么                                   |
| -------------------- | ------------------------------------------ |
| `vp run dev:desktop` | 渲染端 dev server、Electron 外壳、API      |
| `vp run dev`         | API 和浏览器 UI（页面在 `127.0.0.1:3000`） |
| `vp run dev:server`  | 只有 API，监听 `127.0.0.1:18086`           |
| `vp run dev:web`     | 只有浏览器 UI，监听 `127.0.0.1:3000`       |

- `dev:desktop` 先用 `127.0.0.1:18086` 上已有的 server。没有 server 应答时，
  它自己在空闲端口起一个。所以它单独能跑，也能和 `dev:server` 一起跑。
- `dev:web` 需要 server。直接用 `vp run dev`，或者先跑 `dev:server`。
- `dev:web` 和 `dev:desktop` 都绑定 `127.0.0.1:3000`，端口被占用就停下。
  同一时间只跑一个。
- 浏览器用链接登录。server 启动时打印
  `[auth] sign in: http://…/?token=…`，链接打开一次即可，登录态三十天，使用中
  续期。桌面窗口不用链接：令牌在主进程里。
- 第一次启动时还没有供应商。在「设置 → 供应商」里加一个，或者用「调试」
  一节里的假供应商。
- 端口由 `AIFY_API_PORT`（默认 `18086`）和 `AIFY_WEB_PORT`（默认 `3000`）
  决定。要让 server 落在别的源上，设 `AIFY_API_ORIGIN`。详见
  [桌面外壳与 API](docs/development/desktop-and-api.md)。
- 每个 checkout 有自己的 `local.db`，server 启动时应用迁移。改过 schema 就跑
  `vp run db:generate`，看过生成的 SQL 再提交迁移。

### 加一个 UI 组件

UI 在 `packages/ui`。在仓库根目录运行：

```bash
vpx shadcn@latest add button -c apps/web
```

文件落在 `packages/ui/src/components`，用
`@workspace/ui/components/button` 导入。

## 调试

### 渲染端

DevTools 随窗口一起打开。设 `AIFY_OPEN_DEVTOOLS=0` 让它保持关闭。
React DevTools 在第一次启动时装好。

`dev:web` 用浏览器自己的 DevTools。

窗口加载的是 `aify-app://app/`，文档请求反代到 Vite，所以 HMR 在窗口里照常
工作。

### 主进程

在 VS Code 的 Run and Debug 面板里选 **Debug Desktop (Electron Main)**，
配置在 [.vscode/launch.json](.vscode/launch.json)。它自己跑
`electron-forge start` 并带 source map 附加，所以 `apps/desktop/src` 里的断点
能用。先停掉 `dev:desktop`：两者都占 3000。

### 日志

| 看什么                  | 在哪                                                                           |
| ----------------------- | ------------------------------------------------------------------------------ |
| Vite、API server、agent | 跑 dev 命令的终端                                                              |
| 主进程                  | macOS 是 `~/Library/Logs/Aify Zero/main.log`，其他平台是 `app.getPath("logs")` |
| 渲染端                  | DevTools 的 console 和 network                                                 |

server 会打印 `[api] listening on …`、登录链接和迁移错误。

### API

`/api` 路由和 `/health` 都要令牌。令牌在 `~/.aify-zero/api-token`（权限
0600），或者由 `AIFY_API_TOKEN` 给出。

```bash
curl -H "authorization: Bearer $(cat ~/.aify-zero/api-token)" \
  http://127.0.0.1:18086/health
# {"ok":true,"pid":…,"uptime":…}
```

要绕过 `aify-app://` 直接加载 Vite 页面：

```bash
AIFY_APP_PROTOCOL=0 AIFY_API_PORT=18086 vp run dev:desktop
```

Vite 代理在 server 启动前就配好了，所以端口必须固定。`aify-app://` 的 handler
可疑时，用这个口子。

### agent 与供应商

用假供应商控制失败、慢流和流中途报错：

```bash
vp run fake:provider -- --scenario retry-then-succeed
```

然后在应用里加一个供应商，baseURL 填 `http://127.0.0.1:4030/v1`。场景、替身的
日志和该看到的画面在
[docs/testing/fake-provider.md](docs/testing/fake-provider.md)。

### 数据库

```bash
vp run db:studio   # 查看当前 checkout 的库
vp run db:check    # schema 改了却没有迁移时报错
```

要操作别的库，用 `DATABASE_URL` 指过去。

### 检查

| 命令                 | 查什么                                    |
| -------------------- | ----------------------------------------- |
| `vp check`           | 格式、lint、类型                          |
| `vp check --fix`     | 同上，并且应用修复                        |
| `vp test`            | 全部测试                                  |
| `vp test watch`      | 全部测试，改了就重跑                      |
| `vp test run <路径>` | 只跑匹配的测试                            |
| `vp run ready`       | `db:check`、`check`、`test`，然后全量构建 |

## 深入阅读

- [桌面外壳与 API](docs/development/desktop-and-api.md)：server 模式、登录、
  迁移、环境变量。
- [打包](docs/development/packaging.md)：桌面端和 server 的产物。
- [沙箱](packages/sandbox/README.md)：工具在哪跑，能写哪些文件。
- [假供应商](docs/testing/fake-provider.md)：供应商场景与录制回放。
- [ADR](docs/adr)：每个决定的原因。
- [术语表](GLOSSARY-MAP.md)：各包自己的说法。
