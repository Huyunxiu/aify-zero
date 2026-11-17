# 端到端测试

要验「整套东西还串得起来」时看这一页。每个用例一套现场：一个浏览器、一个真实的 API 进程，跑完就拆。

它管的是接缝，不是逻辑：

| 接缝                | 用例怎么碰到它                                    |
| ------------------- | ------------------------------------------------- |
| 浏览器 ↔ 本机 API   | 用 server 打印的登录链接换 cookie，页面自己发请求 |
| HTTP ↔ 运行器       | 发一句话，等运行器把这个回合跑完                  |
| 运行器 ↔ 沙箱       | 模型要一次 `edit-file`，工具真的落在磁盘上        |
| 磁盘 ↔ 改动视图     | 会话面板用基线比较，列出被改的那个文件            |
| 任务注册表 ↔ 收件箱 | 后台命令结算后投一条完成通知，空闲会话因此被唤醒  |
| 通知 ↔ 会话记录     | 那条回合出现在会话里，形状是通知块而不是用户气泡  |

模型侧由[假供应商](fake-provider.md)应答。它替的是供应商，所以这些用例不联网、不花钱、结果确定。

## 跑

```bash
vp run e2e
```

第一次要装浏览器与它的系统库：

```bash
vp exec playwright install --with-deps chromium
```

`--with-deps` 要 root。装在别处就设 `PLAYWRIGHT_BROWSERS_PATH` 指过去；没有 root
时也可以用 `apt-get download` 把缺的库解到本地，再用 `LD_LIBRARY_PATH` 指过去。
把浏览器装进仓库的做法：`PLAYWRIGHT_BROWSERS_PATH=$PWD/.e2e/browsers` 跑
`vp exec playwright install chromium`；缺的包用 `apt-get download` 取下来，
`dpkg-deb -x` 解到 `.e2e/sysroot`，运行时把 `LD_LIBRARY_PATH` 指到它的
`usr/lib/x86_64-linux-gnu`。两者都在 `.e2e/` 下，不会进版本库。

热的一次约 15 秒，其中大半是 Vite 冷启动。

浏览器的 locale 固定成 `en-US`；应用自己的语言走 i18n 默认值——每个用例都是新的
context，`localStorage` 是空的。

## 用例做什么

### 主流程（`journey.e2e.ts`）

1. 用 `/?token=…` 打开，侧栏出现，项目组显示 `No projects`
2. 新建项目，主目录指向一个临时的 Git 仓库
3. 悬停项目行，在项目里新建会话
4. 输入一句话并发送
5. 用户消息出现在会话里
6. 工具步骤出现（`Edit` 开头的那一行）
7. 回合标题变成 `Finished`，回答文字在下面
8. 点右上角的入口展开右侧的会话面板，选「改动」
9. 改动视图说 `1 files changed`，树里有 `notes.md`；点它，被改的那一行就在右边

侧栏状态不参与断言：一个回合结束后它回到 `Idle`，不是 `Done`。终态只认页面里的
`Finished`。

请求序列也是一条断言：恰好 1 次非流式的标题请求、2 次流式的正文请求（先要工具、再回答）。标题和主回合并发，所以只数次数，不咬死顺序。

### 排队的两条消息由一次运行回答（`batching.e2e.ts`）

用户在一次运行里把两条消息排进队列，运行器下一次一起领走，只回答一条。

它必须先制造一个「运行还没结束」的窗口。没有静默窗口，第一条消息会立刻起跑，后两条
只有在第一次运行还在跑时选中「排队」，才会落在同一次领取里。所以现场的剧本是
`slow-answer`：首块延迟 3 秒，够输两条消息。

断言分两层：界面上是三条用户消息、两个 `Finished`、队列清空；假供应商那边是两次流式
请求。只看界面只能证明用户看到一条回复，数请求才证明只跑了一次模型循环。

### 完成通知（`job-notice.e2e.ts`）

场景 `job-notice` 让模型要一条后台命令（`sleep 5; echo done`）。命令活得比第一个回合长，所以：

1. `Bash` 行出现，后台任务真的起来了
2. 第一个回合收尾，仍是 `Finished`
3. 任务结算，通知落进收件箱，空闲会话被唤醒
4. 会话里出现通知块（`role="note"`，标签 `Background job finished`）：抬头带命令与终态 `[status: completed, exit code: 0]`，正文是内联的 `done`
5. 通知块里没有按钮——它不是用户气泡，不给复制与重新生成
6. 被唤醒的那个回合自己跑完，`Finished` 变成 2 个

流式请求是 3 次：要后台命令、第一个回合作答、被唤醒的回合作答。非流式只断言「有」：通知本身也是一个 user 回合，标题生成会为它再问一次，问不问不是这条用例要证明的事。

## 查看现场

默认情况下，成功后会清理临时现场；失败时会保留现场：

```text
.e2e/
├── results/                 # Playwright 的 trace 与截图
└── runs/<时间戳>/
    ├── logs/api.log         # API 进程的 stdout，登录链接与启动恢复都在里面
    ├── logs/web.log         # Vite 的 stdout
    ├── db/app.db            # 这一场用的数据库
    └── project/             # 临时仓库与改过的文件
```

打开 trace：`vp exec playwright show-trace .e2e/results/<用例>/trace.zip`。

要查看成功用例的日志、数据库、临时仓库、截图和 trace，设置 `E2E_KEEP_ARTIFACTS=1`：

```bash
E2E_KEEP_ARTIFACTS=1 vp run e2e
```

成功用例的现场也会留在 `.e2e/runs/<时间戳>/`，trace 和截图在 `.e2e/results/`。
不设置这个变量时，成功用例仍会清理现场，trace 和截图仍只在失败时保存。

## 它是怎么搭起来的

`e2e/harness.ts` 每次跑都做一遍：

- 造临时目录、临时 SQLite、临时 `HOME`，所以不碰你的 `~/.aify-zero`
- `git init` 加一次提交，改动视图才有基线
- 起假供应商（在测试进程内），起 API 子进程，起 Vite dev server，端口都是系统挑的
- 用 Bearer 令牌把供应商写进设置，走的是公开接口，不塞数据库

用例只认用户看得见的东西：文字、按钮名、文件内容。页面里的类名和 DOM 结构不在断言范围里。

## 三个坑

1. **地址栏不反映路由。** `app.tsx` 用内存历史，`page.goto("/sessions/x")` 只会落到 `/sessions`。要换页面就点击。
   面板收起时里面的内容是 `inert`：不先点入口展开，里面的按钮点不动，点击会一直等到超时。
2. **`Start a session`、`Working`、`Finished`、`Approve` 是硬编码英文。** 切到中文也不变。哪天它们进了 i18n，断言会红——应该红，改断言就是。
3. **假供应商的 `toolCall` 只是「能被客户端解析回同一个工具调用」。** 协议级测试
   （`packages/agent/tests/testing/tool-call.test.ts`）证明的是这一点，它不证明假
   供应商与真供应商同形——那种漂移要靠录制回放（`replay`）才发现。

## 加一条用例

现在有三条：主流程、队列领取、完成通知。要加审批路径（`write-file`、MCP 工具）时：

1. 在 `packages/agent/scenarios/` 加一个场景，用 `toolCall` 要那个会询问的工具
2. 在 `e2e/` 加一个 `*.e2e.ts`，用 `startStack({ scenario: "..." })` 换剧本，
   点 `Approve` 后继续断言
3. 用例预算仍是 120 秒，仍然不重试

它不进 `vp run ready`：那是「提交前几秒跑完」的东西，端到端是三分钟的东西，混在一起两个都会坏。
