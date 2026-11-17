# 后台任务（jobs）

模型发起、比一次请求活得更久的命令或工作。这里是它的运行时：注册表记账、生产方执行、工具在模型侧读取和停止。

三层各自只做一件事：

| 层     | 位置                                         | 责任                                                               |
| ------ | -------------------------------------------- | ------------------------------------------------------------------ |
| 注册表 | 本目录 [registry.ts](./registry.ts)          | 身份、归属、生命周期、输出环、事件                                 |
| 生产方 | 例如 [shell/tool.ts](../tools/shell/tool.ts) | 启动并持有执行资源，交出 `{ cancel, done }`                        |
| 控制面 | [tools/jobs.ts](../tools/jobs.ts)            | `job-output` / `job-list` / `job-kill`，把任务翻译成模型能读的文本 |

## 核心不变量

- **任务比请求活得久。** agent 和 `AgentContext` 每次请求重建，注册表是进程级的（[server/src/jobs.ts](../../../server/src/jobs.ts)）。任务归会话 id，不归某次请求。
- **归属是授权边界。** id 形如 `bash-<16 位十六进制>`，可以猜；能不能读只看调用方的会话 id 是否等于拥有者。
- **结算首次优先。** 第一个终态胜出，迟到的生产方结果不会覆盖它。teardown 的强制失败与生产方的正常结算走同一个入口。
- **输出是字节流。** 偏移、保留量、截断全按 UTF-8 字节算，不按字符。
- **一个任务一条环。** 模型的消费游标和观察者的绝对偏移读同一份字节，互不干扰。

## 模块地图

| 文件                         | 职责                                                                     | 副作用         |
| ---------------------------- | ------------------------------------------------------------------------ | -------------- |
| [types.ts](./types.ts)       | `JobSpec` / `JobHooks` / `JobHandle` / `JobView` / `JobEvent` 等公共词汇 | 否             |
| [error.ts](./error.ts)       | 分类错误：找不到、越权、准入上限                                         | 否             |
| [limit.ts](./limit.ts)       | 单次结果的字节上限、UTF-8 安全截尾与落盘                                 | 是（写文件）   |
| [notice.ts](./notice.ts)     | 完成通知的正文：摘要、内联输出与兜底                                     | 否             |
| [ring.ts](./ring.ts)         | 有界输出环：绝对偏移、头部淘汰、UTF-8 安全截尾、非消耗读                 | 否             |
| [pump.ts](./pump.ts)         | 按固定节奏把拉取源搬进环，结算后补抽一次                                 | 是（定时器）   |
| [events.ts](./events.ts)     | 事件路由：按拥有者过滤、隔离监听器异常                                   | 否             |
| [registry.ts](./registry.ts) | 注册表本体：准入、提交、结算、读取、取消、销毁                           | 是（内存记录） |
| [render.ts](./render.ts)     | 模型侧渲染：公共投影、状态行、增量正文                                   | 否             |
| [index.ts](./index.ts)       | 桶文件                                                                   | 否             |

本目录之外的三个消费点：

| 文件                                                      | 职责                                         |
| --------------------------------------------------------- | -------------------------------------------- |
| [tools/jobs.ts](../tools/jobs.ts)                         | 三个模型工具，绑定注册表与当前会话 id        |
| [tools/shell/background.ts](../tools/shell/background.ts) | 后台命令的生产者侧输出缓冲（两条流各一个环） |
| [tools/shell/tool.ts](../tools/shell/tool.ts)             | `run_in_background` 的 schema 分支与任务注册 |

## 数据模型

```ts
JobSpec  = { kind, label, owner?, outputLimitBytes?, output?, run(job: JobHandle): JobHooks }
JobHooks = { cancel(reason?): void; done: Promise<JobOutcome> }
JobHandle = { id, append(text, options?), updateProgress(line) }
JobOutcome = { status: "completed" | "killed" | "failed", detail?, result? }
```

- `kind` 既是分类也是 id 前缀，注册表把它当不透明命名空间。
- `label` 是给模型看的一行（命令本身、派发描述）。
- `owner` 省略即无主任务，任何调用方可见；有主任务只有拥有者的会话能读、能杀、能删。
- `outputLimitBytes` 是单次模型侧结果（读取、完成通知）的字节上限，不影响环的保留量，省略时工具层用 50 KB。取消确认是固定短文案，且必须以任务 id 开头，不参与裁剪。
- `output` 是拉取源：`read(fromByte)` 返回自该偏移以来的文本、下一个偏移、是否已经丢失。
- `result` 是“结果而不是流”的返回值（工作流渲染结果、子 agent 报告），只由结算后的第一次 `read` 交付一次。

`JobStatus` 是 `running` → 可选的 `stopping` → 恰好一个 `completed` / `killed` / `failed`。生产方自己的事实放在 `progress`（运行时）和 `detail`（终态）。

## 一次后台调用的数据流

```text
模型: bash(command, run_in_background: true)
  └─ shell/tool.ts: jobs.start(spec)
       ├─ 校验 kind / label / owner
       ├─ 准入：该 owner 的 running + stopping < N
       ├─ 签发 id，建环，调 run(handle)
       │    └─ runShell(...)              无截止时间，用任务自己的 AbortController
       │         └─ onData → 生产者侧环   background.ts
       ├─ 提交记录 → registered
       ├─ pump 每 150ms 抽一次拉取源 → output
       └─ 立即返回 jobId

模型: job-output(jobId, wait?)
  └─ registry.read() → chunks + (result) + 视图 → 一段带 [status: …] 的文本

命令结束
  └─ done → pump 最后抽干 → settle
        ├─ 释放等待方
        ├─ settled（带 awaited 标记）
        └─ output（终态后的环总量）
```

## 生命周期

### 启动

1. 校验 `kind`、`label`、`owner` 非空。
2. 准入：同一 owner 的 `running + stopping` 达到上限就拒绝，错误信息带上限值。
3. 签发 id，建环与生产者状态。
4. 调 `run()`。**此时记录还没进 store**：starter 里写入的块和进度行会被保留，但不广播。
5. `run()` 成功返回后提交记录，广播 `registered`，再启动泵。泵的第一次抽干在本次调用内同步完成，所以任务的第一条事件永远是 `registered`。
6. `run()` 抛出则什么都不留，id 号段也跳过。

上限默认 10，见 [registry.ts](./registry.ts) 的 `JobRegistryOptions`。宿主目前用默认值。

### 结算

`#settle` 只认第一次：

- 写状态；被 kill 的结算把取消原因并进 `detail`（`signal: SIGTERM; user asked`），跑赢了 kill 的任务保留生产方自己的原因。
- 清进度行，记 `finishedAt`，存 `result`。
- 裁剪环到 `max(结算保留量, total - 模型游标)`：模型还没读走的字节不能先被裁掉。
- 释放等待方，再广播 `settled`。事件里的 `awaited` 表示这次结算释放了一个活着的等待——那个调用方自己拿到了终态，完成通知就不该再说一遍。
- 最后广播 `output`，表示流到此结束。

### 取消与销毁

- `kill` 先调生产方 `cancel()`，再改状态为 `stopping`。`cancel` 抛出时生命周期状态保持原样。
- 拥有者销毁（`disposeOwner`）与服务销毁（`dispose`）：先取消，等每个任务结算，再删记录。`cancel` 抛出时记录被强制判为 `failed`，并报告工作可能成为孤儿。
- `remove` 只接受已结算的记录。它设计给“调用方自己收走终态、没有把 id 交给模型”的场景（前台提升路径），目前还没有调用方。

### 读取

- `read` 从模型游标读到当前总量，然后把游标推满；结算前的读取只有增量，结算后的第一次读取额外带 `result`。
- 终态读取还会把环裁到结算保留量——结算时特意留下的未读字节就是为这一次读取准备的。
- `readAt` 不动游标，按绝对偏移读，供观察者和将来的 UI 使用。

## 输出环

| 事实       | 值                                                                 |
| ---------- | ------------------------------------------------------------------ |
| 偏移单位   | UTF-8 字节                                                         |
| 运行期保留 | 256 KB（`retainBytes`）                                            |
| 结算后保留 | 16 KB（`settledRetainBytes`）                                      |
| 淘汰方式   | 整块从头丢；只有单块就超限时才截成 UTF-8 安全的尾巴                |
| 丢失标记   | 读到的偏移早于 `earliest` 时 `lossy: true`；截尾的块带 `gapBefore` |
| 拉取节奏   | 150 ms（`pumpPollMs`）                                             |
| 结果上限   | 读取与通知 50 KB；超出保留尾巴并写完整结果到会话目录               |

生产者侧（例如后台 shell）有自己的 256 KB 缓冲，与任务环的保留互相独立。两条流（stdout / stderr）各一个环，靠 `channel` 区分；`log` 是生产方旁白，只给观察者看，永远不进模型的消费式读取。

读取失败或抛错的拉取源会被隔离：第一次记日志，之后读作已耗尽，任务按自己的结算走完，不会卡在泵上。

## 事件

| 事件         | 载荷                                         | 时机                   |
| ------------ | -------------------------------------------- | ---------------------- |
| `registered` | 完整视图                                     | 提交后，泵第一次抽干前 |
| `progress`   | 完整视图                                     | `updateProgress` 之后  |
| `stopping`   | 完整视图                                     | `kill` 或销毁取消之后  |
| `settled`    | 视图 + `cause` + `awaited` + `killedByModel` | 释放等待方之后         |
| `output`     | id、owner、总量                              | 每次追加、结算之后     |
| `removed`    | 完整视图                                     | 记录离开可见集合       |

订阅条件只有两种：`{ owner }` 收到该会话的任务以及所有无主任务；`{ owners: "all" }` 收到全部。监听器抛错会被隔离，不影响已经提交的事实和其他监听器。

## 现有生产方

本仓库里只有 shell 一家：

- `kind` 是 `bash` 或 `powershell`，`label` 是命令本身，`owner` 是当前会话。
- `output` 是后台缓冲的两条流。
- `cancel` 触发任务自己的 `AbortController`，`runShell` 收到后终止整个进程组。
- `done` 在进程退出并排空输出后 resolve；被取消结算为 `killed`，其余一律 `completed`，`detail` 是 `exit code: N`——非零退出是普通结果，不是失败，和前台一致。
- 后台没有截止时间；输出按到达顺序写进会话目录下的文件，路径随拉取源上报。

## 新增一个生产方

1. 在 `JobSpec.output` 里给非消耗读取，或者用 `job.append()` 自己推。
2. 在 `run()` 里启动资源，同步返回 `{ cancel, done }`。`done` 必须等资源真正释放，且不得 reject；真 reject 了，注册表记一条违约日志并按 `failed` 结算，不会挂住等待方。
3. 结算时给出 `JobOutcome`；结果而非流的东西放 `result`。
4. 有新的 `kind` 就照现有写法传一个字符串前缀。

```ts
const jobId = jobs.start({
  kind: "pty-send",
  label: `${sessionId}: ${text}`,
  owner: sessionId,
  output: [source],
  run: () => {
    const operation = startOperation();
    return {
      cancel: () => operation.cancel(),
      done: operation.done.then(
        (result) => ({ status: "completed", detail: result.summary }),
        (error) => ({ status: "failed", detail: String(error) })
      ),
    };
  },
});
```

工具不需要为新 kind 做任何事：三个控制工具只认 id。

## 模型侧工具

| 工具         | 输入                           | 行为                                                      |
| ------------ | ------------------------------ | --------------------------------------------------------- |
| `job-output` | `jobId`、`wait?`、`timeoutMs?` | 等待（可选）后读增量；超时或插话返回 `running` 而不杀任务 |
| `job-list`   | —                              | 列出本会话的任务，一行 `<id> [kind] status — label`       |
| `job-kill`   | `jobId`、`reason?`             | 请求取消，返回当前状态                                    |

`wait` 的截止时间由工具自己管（默认 30 秒、上限 10 分钟，宿主可在装配时覆盖），所以超时是正常结果而不是工具失败。用户插话时等待提前结束，状态行写 `user steered`。每次读取的正文最后都有一行 `[status: running, 3/10]` 或 `[status: completed, exit code: 0]`。单次结果超过任务的 `outputLimitBytes` 时保留尾巴，完整结果落盘并把路径交给模型。

输出不会自己流进模型上下文：只有 `job-output` 的工具结果会把环里的字节变成模型能读的文本，而且只交付游标之后的部分。

![job-output 只交付增量：游标只前进，第二次读只拿到剩下的字节](./jobs-output.png)

只在装配了注册表的会话里注册这三个工具；shell 的 `run_in_background` 参数也只在有注册表时出现在 schema 里——没有注册表就没有谁能收走那个 id，schema 不该向模型许诺它。

## 测试

| 文件                                                                               | 覆盖                                                                  |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| [tests/jobs/ring.test.ts](../../tests/jobs/ring.test.ts)                           | 偏移推进、空块、整块淘汰、UTF-8 截尾、跨界读取、流标签                |
| [tests/jobs/registry.test.ts](../../tests/jobs/registry.test.ts)                   | id 格式、准入上限、归属围栏、结算首胜、remove、销毁、拉取泵、事件顺序 |
| [tests/tools/jobs.test.ts](../../tests/tools/jobs.test.ts)                         | 三个工具的增量、结果一次性、等待/超时、归属过滤                       |
| [tests/tools/shell/background.test.ts](../../tests/tools/shell/background.test.ts) | 后台启动、输出可读、取消杀进程、schema 随注册表出现/消失              |

进程用例只在 POSIX 运行。

## 完成通知

任务结算后，注册表把通知交给宿主装上的投递口（`setNoticeAdapter`）。只要不是被等待收走、不是模型自己 `job_kill`、也不是销毁结算，通知就投进拥有者的收件箱：

- 空闲会话被唤醒，开一次运行；忙的会话排到下一个步边界注入。
- 未读输出不超过 2048 字节（且不超过任务的 `outputLimitBytes`）时，通知直接带上输出与终态结果；否则只给摘要，让模型调 `job-output`。
- 模型自己读走同一个任务时，还没送达的通知被撤回。
- 进程重启时，指向已消失任务的通知在启动扫描里删除。
- 通知是用户消息结构里的一种来源（`job-notice`），不是用户说的话：界面单独显示，也不参与插话判定。
- 每条会话自上次用户输入以来最多被唤醒 8 次；超过就只排队，等下一次用户输入。

## 已知限制与下一步

- **记录不回收。** 结算后的记录一直留在进程里，`disposeOwner` 已实现但没有调用方——这个 app 没有删除会话的路由。合理的回收条件是“已结算且模型游标已读空”。
- **通知不持有读取。** 内联通知只有在落进收件箱之后才消费游标：投不出去（会话没有模型、入队失败、模型抢先自己读走）时游标不动，模型之后照常读到那些字节。剩下的窗口是「通知落库了却永远没被领取」（例如会话随后被删除），那段输出就只在那条待办项里。接受这一点：通知会被领取，丢掉的情况只有用户主动清空待办或任务已经不存在。
- **前台调用不注册为任务。** 没有“超时转后台”的提升路径，长命令要么后台跑，要么被截止时间杀掉。
- **单进程。** 重启即丢；跨进程恢复要靠会话持久化，目前不在范围内。
- **子 agent 的任务归父会话**：子 agent 继承父的工具闭包，工具用的是父上下文。
- **准入与事件过滤不区分装配。** 进程里只有一个注册表；多装配的 controller 准入与 scope 过滤没有实现。
