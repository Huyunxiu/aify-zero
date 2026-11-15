# 打包

两个应用都会携带自己的 ripgrep 可执行文件：agent 的 `glob`/`grep` 工具要执行
它，而可执行文件既不能内联进 JS bundle，也不能从 asar 归档里运行。
`scripts/stage-ripgrep.ts` 会把 `@vscode/ripgrep` 为当前平台提供的二进制复制
过去，并补回可执行权限。

- 桌面端：`vp run package:desktop` 打包前先把二进制放到
  `apps/desktop/resources/bin/rg`，`packagerConfig.extraResource` 会把它带进
  `Resources/resources/bin`；主进程在 fork 内置 server 之前把
  `AIFY_RIPGREP_PATH` 指向它（并把它所在目录加到 `PATH` 前面）。
- Server：`vp run package:server` 先用 Vite 构建 `apps/server/dist`，再执行
  `scripts/stage-server-dist.ts` 补上 `node_modules/@libsql/`（原生绑定）、
  `@lydell/node-pty` 的平台包、`bin/rg` 和标记 ESM 的 `package.json`。产物是
  自包含的，用 `node apps/server/dist/index.js` 启动；只要 `bin/rg` 存在，
  入口就会自动设置 `AIFY_RIPGREP_PATH`。

agent 的解析顺序是 `AIFY_RIPGREP_PATH` → 随包的 `bin/rg` → `PATH` 上的 `rg`，
因此开发期不需要打包二进制也能正常工作。
