# 端到端测试

> 中文副本。以 [`e2e.md`](./e2e.md) 为准。

要验「整套东西还串得起来」时看这一页。每个用例一套现场：一个浏览器、一个真实的 API 进程，跑完就拆。

它管的是接缝，不是逻辑：

| 接缝                    | 用例怎么碰到它                                    |
| ----------------------- | ------------------------------------------------- |
| 浏览器 ↔ 本机 API       | 用 server 打印的登录链接换 cookie，页面自己发请求 |
| HTTP ↔ 运行器           | 发一句话，等运行器把这个回合跑完                  |
| 运行器 ↔ 沙箱           | 模型要一次 `edit-file`，工具真的落在磁盘上        |
| 磁盘 ↔ 改动视图         | 会话面板用基线比较，列出被改的那个文件            |
| 任务注册表 ↔ 收件箱     | 后台命令结算后投一条完成通知，空闲会话因此被唤醒  |
| 定时器 ↔ 收件箱         | 定时器到点后投一条待办项，空闲会话因此被唤醒      |
| 日程 ↔ 收件箱与库       | 日程到点后投一条待办项，那一行推进而不是删除      |
| 通知 ↔ 会话记录         | 那条回合出现在会话里，形状是通知块而不是用户气泡  |
| 发件箱 ↔ 应用通道       | 订阅那条通道，运行落定后收到通知，回执后状态归零  |
| 审批策略 ↔ 运行器与界面 | 会话存的策略装进运行，卡片出不出由它决定          |

模型侧由[假供应商](fake-provider.md)应答。它替的是供应商，所以这些用例不联网、不花钱、结果确定。

## 跑

```bash
vp run e2e
```

一条短用例约 8 秒，范围 2.7 到 13.9 秒。整套在 macOS arm64 上约 4.5 分钟：13 个文件、
16 条用例。三条用例各等几十秒，占掉大部分时间：`approval-policy`（Unattended）66 秒、
`schedule` 35 秒、`timer` 66 秒。

整套要一个 Chromium 浏览器。macOS 上一条命令就够，系统库随操作系统一起来：

```bash
vp exec playwright install chromium
```

浏览器落在 `~/Library/Caches/ms-playwright`。`--with-deps` 在 darwin 上是空操作：
`playwright-core` 只对 win32 与 linux 处理这个参数。

Linux 有 root 时，一条命令把浏览器与它的系统库都装上：

```bash
vp exec playwright install --with-deps chromium
```

Linux x86_64 没有 root 时，把浏览器与库都放进仓库，再用两个变量指过去：

```bash
PLAYWRIGHT_BROWSERS_PATH=$PWD/.e2e/browsers \
LD_LIBRARY_PATH=$PWD/.e2e/sysroot/usr/lib/x86_64-linux-gnu \
vp run e2e
```

备好这两个目录：用 `PLAYWRIGHT_BROWSERS_PATH=$PWD/.e2e/browsers vp exec playwright
install chromium` 装浏览器；缺的包用 `apt-get download` 取下来，逐个用 `dpkg-deb -x`
解到 `.e2e/sysroot`。两者都在 `.e2e/` 下，不会进版本库。这些包是 x86_64 Linux 的
二进制，换一个架构就得换一套。

### 跑一条

把文件路径传给 Playwright：

```bash
vp exec playwright test --config e2e/playwright.config.ts e2e/outbox.e2e.ts
```

`vp run e2e -- e2e/outbox.e2e.ts` 不报错，但整套全部跑一遍：`vp run` 把 `--` 和路径
一起传下去，Playwright 不把路径当过滤条件。

### 浏览器装在别处

Linux x86_64 上，`PLAYWRIGHT_BROWSERS_PATH` 指到那份安装，`LD_LIBRARY_PATH` 指向装着
解包库的 `usr/lib/x86_64-linux-gnu`：

```bash
PLAYWRIGHT_BROWSERS_PATH=<浏览器目录> \
LD_LIBRARY_PATH=<库目录>/usr/lib/x86_64-linux-gnu \
vp run e2e
```

在 macOS 上只有 `PLAYWRIGHT_BROWSERS_PATH` 一个变量：Chromium 要的系统库由系统提供。

worktree 里要注意：harness 把仓库根算成 worktree 自己，所以 `.e2e/` 也是
worktree 自己的。浏览器可以只装一份，用 `PLAYWRIGHT_BROWSERS_PATH` 指到主
checkout 的那份。

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

### 审批策略（`approval-policy.e2e.ts`）

三条用例各证明一条接缝：策略存得下、运行读得到、界面按它决定问不问。

1. 编辑档：发一句话让模型改文件；工具真的跑了，文件落盘，回合收尾，没有审批卡。
2. 只读档：同样的场景，工具被拒绝，回合照样收尾，文件一个字都没变，没有审批卡。
3. 定时器：会话里存的是编辑策略，定时器唤起的运行没人看着，也没有任何一层收紧它；
   改动直接落盘，不出现审批卡——没人发起的运行用的就是会话存的那一档。

第 3 条要等满定时器 60 秒的下限，再等扫描循环唤醒会话。它给自己放宽到 180 秒；
`playwright.config.ts` 里的默认值是 120 秒。

行为矩阵（四个策略 × 五个类别，宿主规则与 hook 的折叠）不在这里：那部分归
`packages/agent/tests` 的表驱动用例。hook、MCP 注解、子代理、fork、压缩都够不到这套
现场，写在这里只会变成假证据。

### 排队的两条消息由一次运行回答（`batching.e2e.ts`）

用户在一次运行里把两条消息排进队列，运行器下一次一起领走，只回答一条。

它必须先制造一个「运行还没结束」的窗口。没有静默窗口，第一条消息会立刻起跑，后两条
只有在第一次运行还在跑时选中「排队」，才会落在同一次领取里。所以现场的剧本是
`slow-answer`：首块延迟 3 秒，够输两条消息。

断言分两层：界面上是三条用户消息、两个 `Finished`、队列清空；假供应商那边是两次流式
请求。只看界面只能证明用户看到一条回复，数请求才证明只跑了一次模型循环。

### 完成通知（`job-notice.e2e.ts`）

场景 `job-notice` 让模型要一条后台命令（`sleep 5`，输出 `done`）。命令活得比第一个回合长，所以：

1. `Bash` 行出现，后台任务真的起来了
2. 第一个回合收尾，仍是 `Finished`
3. 任务结算，通知落进收件箱，空闲会话被唤醒
4. 会话里出现通知块（`role="note"`，标签 `Background job finished`）：抬头带命令与终态 `[status: completed, exit code: 0]`，正文是内联的 `done`
5. 通知块里没有按钮——它不是用户气泡，不给复制与重新生成
6. 被唤醒的那个回合自己跑完，`Finished` 变成 2 个

流式请求是 3 次：要后台命令、第一个回合作答、被唤醒的回合作答。非流式只断言「有」：通知本身也是一个 user 回合，标题生成会为它再问一次，问不问不是这条用例要证明的事。

### 定时器（`timer.e2e.ts`）

场景 `timer` 让模型排一个 60 秒的跟进，然后停在这里。它真的等满一分钟：

1. 第一个回合收尾，`Finished` 是 1 个，会话回到空闲
2. 到点后扫描循环把定时器换成收件箱里的一行，空闲会话被唤醒
3. 会话里出现通知块（`role="note"`，标签 `Timer fired`），正文带着模型当时写下的备注
4. 通知块里没有按钮——它不是用户气泡
5. 被唤醒的那个回合自己跑完，`Finished` 变成 2 个

扫描间隔在 e2e 里降到 1 秒（`AIFY_TIMER_SCAN_MS`），否则最坏要等满两个周期、超过用例上限。定时器自己的 60 秒下限不动：那是契约，用例就该真的等。

流式请求是 3 次：排定时器、第一个回合作答、被唤醒的回合作答。

### 日程（`schedule.e2e.ts`）

场景 `schedule` 在运行时算出来：`daily` 写的是当地「几点几分」，所以把目标定在
`LEAD_MS = 20_000` 之后、下一个整分，模型据此排一个日程。实测等待约 35 秒，300 秒的
间隔下限不必动。

和定时器用例走同一条链路，差别只在收尾：

1. 第一个回合收尾，`Finished` 是 1 个，会话回到空闲
2. 到点后通知块出现（标签同样是 `Timer fired`），正文说得出来规则和 `Next:`
3. 从 `/api/openapi/timer/state` 读回 `pendingSchedules`：**是 1**——那一行还在，只是到期
   时刻前进了。这是跟进的用例给不了的断言
4. 被唤醒的那个回合自己跑完，`Finished` 变成 2 个

第 3 步要带 `Authorization: Bearer`：这条读的路径和别的接口一样要凭据。

### 发件箱（`outbox.e2e.ts`）

场景 `outbox` 只有一次不需要工具的作答：跑完就有话要带给用户。这条用例和别的不一样，
它不开页面：

1. 用例扮演桌面主进程那条连接：连上 `/api/ws`，发 `outbox.subscribe`
2. 用接口开一条会话、发一句话，运行器把这个回合跑完
3. 落定两秒之后通知推过来：正文取那个回合的最后一段文字，标题是会话标题
4. 回执发回去
5. `GET /api/openapi/outbox/state` 说：没有等着投的行，推过一条，有连接在等
6. 再等三个扫描周期也没有第二批——同一行只推一次

不开页面是有意的：页面一收到 `run.end` 就把会话标成已读，而「有人看了」正是不该弹
通知的理由。要验的正是反面，所以用例得自己扮那个没在看的人。

桌面进程跑不进 Playwright，所以第 1、3、4 步由用例自己做。它说的是同一份协议
（`@workspace/shared/ws-protocol`），协议一改，它和桌面一起红。

### 隐藏窗口（`outbox-hidden.e2e.ts`）

桌面「关窗」只是 `hide()`，页面还在，也会收到 `run.end`。这条用例补上
`outbox.e2e.ts` 不看页面所覆盖不到的那一半：

1. 页面建项目、开会话、发一句话；场景是 `slow-answer`，首块延迟三秒
2. 运行落定前把文档切到 hidden——Electron 隐藏窗口时 Chromium 给的就是这个状态
3. 回合落定后通知仍推过来，会话还是 `done`
4. 恢复可见后页面补做标记已读，会话变 `idle`

隐藏时标记已读，投递器就会以为有人看过，系统通知永远不弹。标记已读因此以页面
可见为准，不是以页面存在为准。

### Bot 头像是一份存下来的资产（`bots-avatar.e2e.ts`）

头像是上传的图片，存在 Bot 自己的 `assets/` 目录下，走一条按 owner 取的字节路由。
这个 Bot 的每一处脸都画同一份字节。

1. 从侧边栏行菜单打开设置。上传之前页面不画图片，脸就是名字的首字母
2. 上传一张 1×1 PNG。设置头部与侧边栏行都显示它；路由校验文件头，1×1 的文件就够了
3. 回到会话，三处脸带着这张图：侧边栏行、会话头部、助手消息行
4. 刷新，三处还在：图是存下来的，不是留在内存里
5. 删掉图像，每一处脸回到首字母

### Bot 的设置是地址（`bots-settings.e2e.ts`）

设置的每一节都有自己的地址，所以可以只把一节发给别人，也可以刷新它。Bot 的裸地址
与 `/settings` 都不指名哪一节，两者都把读者交给第一节，而不是画一个没有节的页面。

1. `Configure` 打开 `/bots/<id>/settings/general`；设置在运行还在跑的时候打开，运行
   在它后面收尾——盖住会话不会停掉它
2. `MCP servers` 是导航到 `/settings/mcp`，`goBack` 回到 `/settings/general`
3. `Back to app` 回到会话的地址，不是回到上一节
4. 会话留着草稿，也没有重放回合：`Finished` 只有一个，草稿还在输入框里
5. 裸地址与 `/settings` 用 `replace` 换掉自己在历史里的位置，所以 `goBack` 落在会话上
6. 一节的地址可以单独打开，刷新后还在

### 删除会话会清掉它的行与它占的页面（`session-delete.e2e.ts`）

1. 两个会话，各跑一个回合，各有一个标题
2. 行菜单里的 `Delete` 打开确认框，框里写的是那一条会话
3. 列表少一行，页面回到空白态（`Start a session`），另一个会话还在
4. 刷新，删掉的会话仍然不在：藏起来的是服务端，不是缓存

### 侧边栏按最后活动排序（`session-order.e2e.ts`）

1. 会话甲跑一个回合，会话乙跑一个回合；乙在创建时刻与最后活动上都更新
2. 回到甲再跑一个回合；甲创建更早、却更晚活动，所以它必须回到第一行
3. 两行都写着 `Just now`，用例比较两个标题的纵向坐标，所以断言读的是用户看到的顺序
4. 这里的硬证据是请求次数：3 个回合对应 3 次流式回答，2 个会话对应 2 次非流式标题请求

### 设置盖住会话，不替换它（`settings-keepalive.e2e.ts`）

两条用例。第一条在运行还在流的时候打开设置，输入框里留着没发出去的草稿。回来必须
还是同一条会话：一个收尾的回合、没有重放、草稿还在输入框里。第二条从会话列表出发，
那里没有会话 id，它证明那个页面的草稿也扛得住设置。

## 查看现场

默认情况下，成功后会清理临时现场；失败时会保留现场：

```text
.e2e/
├── results/                 # Playwright 的 trace 与截图
└── runs/<时间戳>/
    ├── home/                # 这一场用的临时 HOME
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

1. **深链能落到页面上；收起的面板不会应答。** `app.tsx` 在 web 上用
   `createBrowserHistory`、在桌面上用 `createHashHistory` 建路由，所以
   `page.goto("/sessions/<id>")` 会打开那条会话，地址也不变。
   面板收起时里面的内容是 `inert`：不先点入口展开，里面的按钮点不动，点击会一直等到超时。
2. **`Start a session`、`Working`、`Finished`、`Approve` 是硬编码英文。** 切到中文也不变。哪天它们进了 i18n，断言会红——应该红，改断言就是。
3. **假供应商的 `toolCall` 只是「能被客户端解析回同一个工具调用」。** 协议级测试
   （`packages/agent/tests/testing/tool-call.test.ts`）证明的是这一点，它不证明假
   供应商与真供应商同形——那种漂移要靠录制回放（`replay`）才发现。

## 加一条用例

一个文件是一个场景，可以有一条或多条用例：13 个文件、16 条用例。要加审批路径
（`write-file`、MCP 工具）时：

1. 在 `packages/agent/scenarios/` 加一个场景，用 `toolCall` 要那个会询问的工具
2. 在 `e2e/` 加一个 `*.e2e.ts`，用 `startStack({ scenario: "..." })` 换剧本，
   点 `Approve` 后继续断言
3. 默认预算是 120 秒，用例都不重试。四条用例给自己放宽：`approval-policy` 180 秒、
   `outbox-hidden` 150 秒、`schedule` 210 秒、`timer` 150 秒。

它不进 `vp run ready`：那是「提交前几秒跑完」的东西，端到端要 4.5 分钟左右。混在一起两个都会坏。
