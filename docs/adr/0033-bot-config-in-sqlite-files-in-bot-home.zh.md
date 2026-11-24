# Bot 结构化配置存 SQLite，文件型资源落 Bot 主目录

> 中文副本。以 `0033-bot-config-in-sqlite-files-in-bot-home.md` 为准。

Bot 的结构化配置（身份、默认模型引用与档位、系统提示词、工具组开关、默认审批策略、沙箱配置、环境变量、
MCP 服务器定义、全局资源继承模式及默认项目）统一以 SQLite（`bot` 表）为唯一真源。文件型资源
（`skills/**/SKILL.md`、`AGENTS.md` 及可选隔离 `home/`）存放在 Bot 主目录
（`~/.aify-zero/bots/<botId>/`），不引入镜像的 `bot.json` 或 `mcp.json`。

程序托管目录统一落在 `~/.aify-zero`（支持通过 `AIFY_DATA_DIR` 覆盖），而不使用 Electron `userData` 或
`~/Documents`：独立启动的 API server 没有 Electron `userData`，且系统文稿目录会触发权限弹窗与云盘同步
冲突。`bot.workspace_dir` 预留自定义宿主路径列（v1 固定使用 `<botHome>/workspace`）。会话私有目录继续
保持平铺路径 `~/.aify-zero/sessions/<sessionId>`。

Bot 私有 MCP 服务器复用进程级 `McpManager`（延续 ADR 0001），通过全局唯一的服务器 id 隔离连接与
授权凭据，并在 stdio 传输启动时注入该 Bot 的工作目录 `cwd` 与私有环境变量。

## 考虑过的选项

- **全文件配置（在 Bot 主目录存 `bot.json` / `mcp.json`）**：会和 SQLite 产生双写同步风险，并把服务器
  定义与 `mcp_credential` 授权凭据割裂开。
- **放在 Electron `userData` 或 `~/Documents`**：脱离桌面壳的独立服务端无法依赖 `userData`；路径含空格或
  触发系统文稿权限与云盘冲突。
- **把会话目录嵌套进 `bots/<botId>/sessions/<sessionId>`**：会增加删除 Bot、目录迁移及
  `workspace.service.ts` 的路径耦合。

## 后果

- 每类数据只有一个权威：Drizzle/Zod 负责校验结构化配置与脱敏环境变量，文件系统扫描直读 `skills/` 与
  `AGENTS.md`。
- 删除 Bot 时软删除对应记录并吊销私有 MCP 凭据，默认保留磁盘上的 Bot 主目录，仅在用户显式勾选确认时才执行物理删除。
- Bot 私有 MCP 与全局 MCP 共用同一套连接复用、空闲回收和 OAuth 回调机制。
