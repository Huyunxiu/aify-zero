# 环境

> 中文副本。以 [`environment.md`](./environment.md) 为准。

仓库除了 `node_modules` 还需要什么，以及检查在改动没碰过的文件里失败时怎么办。

## 安装

```bash
CI=true vp install --frozen-lockfile
```

直接 `vp install` 在要重建 `node_modules` 时会停下：

```text
ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY
```

它要一个终端来确认这次删除，而 agent 的 shell 没有终端。`CI=true` 替这一条命令回答一次。
`--frozen-lockfile` 让锁文件保持原样，所以这次安装也改不了任何一个依赖。

## 原生包

三个依赖按平台各发一个包：

| 依赖               | 做什么           | 目录                   |
| ------------------ | ---------------- | ---------------------- |
| `sharp`            | 附件里的图片解码 | `node_modules/@img`    |
| `@libsql`          | 数据库的原生绑定 | `node_modules/@libsql` |
| `@lydell/node-pty` | 终端的原生绑定   | `node_modules/@lydell` |

它们是可选依赖。一次跳过可选包的安装会把它们落下，而且不报错。缺口随后看起来像四件
互不相关的事：

| 症状                 | 落在哪                                                                |
| -------------------- | --------------------------------------------------------------------- |
| 约 120 条类型错误    | `packages/agent/src/attachments/`                                     |
| 15 条测试失败        | `attachments/normalize.test.ts`、`tools/read-file.test.ts`            |
| 一个构建任务失败     | `scripts/stage-server-dist.ts`，报「sharp platform packages missing」 |
| 数据库或终端载不进来 | 运行时                                                                |

这些文件没有一处是这次改动。`vp run doctor` 会点名缺的那个包，以及装它的命令。

## 浏览器

`vp run e2e` 要 Chromium。它不在 `node_modules` 里；Playwright 把它放在自己的缓存里，设了
`PLAYWRIGHT_BROWSERS_PATH` 就放在那里。`vp run doctor` 读的也是这两处。

```bash
vp exec playwright install chromium
```

装不了浏览器的 Linux 机器要按 [`docs/testing/e2e.zh.md`](../testing/e2e.zh.md) 里的手工步骤来。

## doctor 不查什么

它只读目录。它不跑模型、不起服务、不看配置。干净的 CI 安装什么都不缺，所以 CI 不跑它；
本地和 CI 说法不一致时，它才有用。
