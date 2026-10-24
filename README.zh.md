# Vite+ Monorepo Starter

[English](README.md) | 简体中文

用于创建 Vite+ monorepo 的起始模板。

## 开发

- 检查一切是否就绪：

```bash
vp run ready
```

- 运行测试：

```bash
vp run -r test
```

- 构建整个 monorepo：

```bash
vp run -r build
```

- 启动开发服务器（每个都在各自的终端中运行）：

```bash
vp run dev:server   # 独立的 Hono API，监听 127.0.0.1:18086（apps/server）
vp run dev:web      # 浏览器 UI，监听 127.0.0.1:3000，并将 /api 代理到 API
vp run dev:desktop  # Electron 外壳；通过 aify-app:// 加载 UI
```

`dev:web` 和 `dev:desktop` 都会绑定 `127.0.0.1:3000`（strictPort），因此同一时间只能运行其中一个。`dev:desktop` 不依赖 `dev:server`：当 API 端口上没有任何进程监听时，它会自行启动内置服务器（见下文）。可通过 `AIFY_API_PORT`、`AIFY_WEB_PORT` 和 `AIFY_API_ORIGIN` 覆盖端口。

`dev:api` 仍作为 `dev:server` 的别名保留。

- 添加依赖

```bash
vp i xxx --filter ./packages/ui
```

## 桌面外壳

打包后的应用加载 `aify-app://app/`。Electron 的 `protocol.handle` 处理器从磁盘提供构建后的渲染器文件，并将 `/api` 命名空间转发到 API 服务器（一个真实的 HTTP 源，见下文）；在开发模式下，它会把文档请求代理到 Vite，以便 HMR 继续工作。设置 `AIFY_APP_PROTOCOL=0` 可直接加载 Vite URL（用于调试的应急开关）。

### API 服务器模式

API 位于 `apps/server`（`@workspace/server-app`），是唯一的监听者。桌面端通过 `AIFY_SERVER_MODE` 在三种模式中选择一种：

| 模式           | 行为                                                                                                                                                                                   |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auto`（默认） | 若设置了 `AIFY_API_ORIGIN` 则使用它；否则探测 `AIFY_API_HOST:AIFY_API_PORT`（默认 `127.0.0.1:18086`，开发期会短暂重试），若有服务器响应 `GET /health` 则连接到它；否则启动内置服务器。 |
| `owned`        | 始终在 `utilityProcess` 中启动内置服务器（`.vite/build/server-entry.js`）；该模式下 `AIFY_API_ORIGIN` 会被忽略。                                                                       |
| `attach`       | 从不启动内置服务器；要求 `AIFY_API_ORIGIN` 或默认源上存在外部服务器。                                                                                                                  |

内置 server 默认使用系统分配的端口（就绪行会报告实际端口），因为渲染端始终经主进程转发；设置 `AIFY_API_PORT` 才会强制固定端口。`AIFY_APP_PROTOCOL=0` 需要固定的 `AIFY_API_PORT`（或 `AIFY_API_ORIGIN`），因为 Vite 代理在 server 启动前就已经配置好。

渲染窗口会在内置 server 还在启动时就显示。`aify-app://` handler 会把这段时间的 API 请求挂起，等 server ready 后再转发；只有在确实不可用时才返回带 `retry-after` 的 `503`。ready 之后意外退出的内置 server 会按退避最多重启 3 次；这段窗口期里的瞬时 503 会被 query client 重试几秒。主进程还会向渲染端推送 `server-status`，启动/重连期间会显示一个小状态条。

API 的每个请求都必须带 `Authorization: Bearer <token>`。桌面主进程在转发 `aify-app://` 请求时注入，渲染端永远看不到令牌；`dev:web` 的 Vite 代理也会注入。令牌优先取 `AIFY_API_TOKEN`，未设置时读取 `~/.aify-zero/api-token`（首次启动 server 时以 `0600` 创建），因此同一台机器上的 `dev:server` 和桌面端共享同一个令牌。连接另一台机器上的 server 时，必须在桌面端环境里显式设置 `AIFY_API_TOKEN`。如果覆盖了 `AIFY_API_TOKEN`，请给所有访问 server 的进程（`dev:server`、`dev:web`、桌面端）设置同一个值，或者全部不设置、统一使用共享文件。

因此，打包后的应用默认自带并拥有自己的服务器，而 `dev:server` + `dev:desktop` 则共享同一个进程。桌面端同时只允许一个实例：再次启动只会聚焦已有窗口，不会另起一套 server，也不会打开同一个数据库。要把正在运行的桌面端从内置服务器迁移走，可在渲染器或 DevTools 中调用 `aifyDesktop.useServer("http://127.0.0.1:18086")`：主进程会校验 `/health`、停止归自己所有的子进程、切换 `aify-app://` 转发器并重新加载页面。运行期切换只接受回环地址；远程 server 必须在启动前通过 `AIFY_API_ORIGIN` + `AIFY_API_TOKEN` 配置。

打包后的应用会基于 `Resources/migrations` 中随包携带的迁移文件（见 `packagerConfig.extraResource`）创建/迁移 `~/.aify-zero/aify-zero.db`；内置服务器进程会在启动时执行迁移。开发环境使用仓库中的 `local.db`，且从不自动迁移（开发库的表结构由 `db:push` 管理）。如果某个打包环境的数据库是由 `db:push` 创建的，它就没有迁移历史：请将 `DATABASE_URL` 指向该数据库，并先运行 `vp run db#db:migrate`，否则打包应用启动时会显示迁移错误。

环境变量由进程入口加载，而不是由库模块加载：`apps/server` 依次读取 `apps/server/.env` 和仓库根目录的 `.env`，桌面端则把自己的环境变量传给内置子进程。因此 `.env` 中的相对路径 `DATABASE_URL` 会相对于进程的工作目录解析——建议使用绝对路径或默认值。

## 添加组件

要为自己的应用添加组件，请在 `web` 应用根目录执行以下命令：

```bash
vpx shadcn@latest add button -c apps/electron
```

这会把 UI 组件放到 `packages/ui/src/components` 目录中。

## 使用组件

要在应用中使用这些组件，请从 `ui` 包导入它们。

```tsx
import { Button } from "@workspace/ui/components/button";
```

## 调试

### .vscode/launch.json

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "type": "node",
      "request": "launch",
      "name": "Debug Desktop (Electron Main)",
      "cwd": "${workspaceFolder}/apps/desktop",
      "runtimeExecutable": "${workspaceFolder}/node_modules/.bin/electron-forge",
      "runtimeArgs": ["start"],
      "console": "integratedTerminal",
      "autoAttachChildProcesses": true,
      "sourceMaps": true,
      "outFiles": ["${workspaceFolder}/apps/desktop/.vite/build/**/*.js"],
      "skipFiles": ["<node_internals>/**", "**/node_modules/**"]
    }
  ]
}
```
