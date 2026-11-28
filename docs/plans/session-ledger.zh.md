# 会话流水

> 中文副本。以 [`session-ledger.md`](./session-ledger.md) 为准。

一个会话保存一份只追加的记录文件。回放读这份文件。它不替换会话记录，数据库也不保存它。

理由是一个今天答不出来的问题：模型看到了什么，按什么规则动手。三个事实决定答案，而它们都没存：

- 模型路线是每个回合决定的，`turn_start` 钩子能改它；
- 审批策略是每条运行读一次，只留当前值；
- 装配出来的系统提示词一个字都没存。

流水把这些事实记在产生它们的事件旁边。于是 03:00 发生的故障，10:00 还能读。

## 目标

复现一次故障：每一步的输入、输出、生效配置都在，崩溃不会抹掉它们。会话面板里的时间线是免费的副产品，不是独立目标。审计与评测夹具不在范围内。

## 放在哪

```
<dataDir>/sessions/<sessionId>/ledger.jsonl            记录
<dataDir>/sessions/<sessionId>/ledger/prompts/<sha256>  一份系统提示词，一个摘要一个文件
```

会话目录里已经有 `attachments/`。流水放在它旁边。

子代理会话有自己的流水，因为子代理就是一个会话。父会话通过 `tool.result.metadata.sessionId` 指认子会话。没有记录重复这个指认。

## 一行

一行一个 JSON 对象。五个字段排在前。

| 字段    | 类型           | 作用                                                       |
| ------- | -------------- | ---------------------------------------------------------- |
| `line`  | number         | 记录地址。从 1 起，永不重置。也用来证明没有缺行            |
| `v`     | `1`            | 这一行的格式版本。读者按它解析。它是常量类型，写错编译不过 |
| `at`    | number         | 写入时刻，epoch 毫秒。回放的墙钟轴                         |
| `epoch` | string \| null | 通道实例。从中间开始读的读者需要它                         |
| `type`  | string         | 记录名。第一个点分族                                       |

早先的草稿删掉了两个字段，理由仍然成立：

- `kind` 重复了 `type` 已经说的话。一个事实两处描述，早晚不一致。
- `seq` 没有读者。分页用 `line`，直播路径不读流水。将来回放要从直播游标接着读时再加。加字段不需要新版本。

`at` 和事件自己的 `createdAt` 可以不同。排序和墙钟轴用 `at`。事件的含义用它自己的 `createdAt`。两者不互相覆盖。

## 两族

族决定读者走哪条路。完整的 `type` 决定这条记录怎么处理。

**`stream.*`** 是屏幕上的过程。回放靠它重建面板。

**`note.*`** 是屏幕没显示过的事实。回放把它画成标注。

`stream.*` 有 3 个成员，不会长。`note.*` 有 9 个，会长。

## 记录

### `stream.run.start`

`streamId`，以及运行领取过收件箱项时的 `turnIds` / `turns`。

用户回合的正文只从这里进流水。用户回合没有步骤，`note.step.settled` 覆盖不到它。

### `stream.run.event`

`streamId` 和 `event`，也就是原样的 `AgentStreamEvent`。30 种里记 27 种。不记的三种是 `text.delta`、`reasoning.delta`、`tool.input-delta`。

### `stream.run.end`

`streamId`，运行失败时带 `failure`。这里缺一条就是崩溃的证据，而可以推导出来的值不能当证据。

### `note.process`

`pid` 和 `appVersion`，每个进程对每个会话写一次。

封套上的 `epoch` 替代不了它。通道活到会话空闲为止，下一次运行会开一个新通道，所以
`epoch` 变了不等于进程换了。这条记录是「另一个进程写过这些行」的唯一证据。

### `note.inbox.arrived`

`inboxItemId`、`inboxKind`、`dedupeKey`、`deliverAt`。种类从 `InboxKind` 导入，不抄进流水。在运行领取它之前，没有别的记录提到它。

### `note.inbox.claimed`

`inboxItemId` 和 `turnId`。只有用户消息的 `dedupeKey` 等于它的 turn id。通知和定时器不是，所以这个连线推不出来。

### `note.inbox.discarded`

`inboxItemId` 和 `reason`。没有被领取不等于被取消：还在排队的和被丢掉的东西，从别的记录看一模一样。

### `note.turn.settings`

`turnId`、`streamId`、`model`、`effort`、`approvalPolicy`、`instructions`、`sections`。只给调模型的回合写，别的回合不写。

`instructions` 是 `{sha256, bytes}`，正文在 `ledger/prompts/`。`sections` 是 `{id, priority, sha256}[]`，所以读者能说出这份提示词由哪几段拼成。

`effort` 在宿主没指定时缺省：填个默认值等于描述一次从没用过它的调用。`turn_start` 钩子整份替换提示时 `sections` 为空，因为没有哪一段拼出了发出去的那份。

这四个事实随每个回合走，不记成变更事件。变更点从相邻两条生效值推得出来。反过来不成立：漏记一次变更，之后每个回合都错。

### `note.turn.superseded`

`turnId` 和 `streamId`。重新生成的回合保留它的 id，也保留它的全部记录：那一行是被再写一次，变的是这次尝试，不是这个回合。

同一个 turn id 出现在两个 stream 下有两种原因：用户重新生成了答案，或者运行在审批之后继续。继续不领取待办项，而重新生成领取的是分支里已经存在的那个 turn id。这条记录标的就是后者。

### `note.step.settled`

`turnId`、`stepId` 和 `content`，整份 `AgentStep`。步骤落定时写一次，它的 metadata 到达时再写一次，所以同一个 `stepId` 可以出现多次。读者取最后一条。

它和数据库里的内容重复。这是故意的：重新生成会覆盖那一行，而旧的尝试必须留在流水里。

失败的一步从不落定：数据库不为它留行，这条记录也不替它编一行。读者拿到的是 `note.step.delta-backlog` 里那段打字过程。

### `note.step.delta-backlog`

`turnId`、`stepId`、`truncated` 和 `chunks`。只出现在失败或被打断的步骤上。delta 缓冲在失败的那一刻倒出来，所以这条记录可能排在报告失败的那条 `stream.run.event` 之后。

### `note.recovery`

`turnId` 和 `reason`。它把模型的错误和进程崩溃后代填的错误分开。

## 写

流水先写，步骤后落定。

```text
onStreamEvent(streamId, event)
  if event 是 delta
    buffer[event.stepId].push(event)          // 只在内存，上限 256 KiB
    return
  append({type: "stream.run.event", streamId, event})
  if event 是 step.finish 且 event.status 是 "error"
    append({type: "note.step.delta-backlog", ...buffer[event.stepId]})
    drop(buffer[event.stepId])

append(payload)
  line = 下一个行号
  write({line, v: 1, at: now(), epoch: currentEpoch, ...payload})
  失败时：计数、告警、继续               // 运行绝不因为流水失败
```

`write()` 在字节落进文件后返回，所以进程崩溃什么都不丢。`fsync` 在每个步骤边界跑，所以断电最多丢当前这一步。

最后一行可能被截断。读者丢掉它。

## 读

一条只读路由：`GET /sessions/{id}/ledger?from=<line>&limit=<n>`。投影是 `replayLedger`，一个压在记录上的纯函数，所以服务端不加第二个概念，测试也能把时间线和产生它的事件对起来。

投影跑两遍，顺序不能反，因为内容可能比描述它的事件晚到。

```text
第一遍：搭结构
  for 每条流记录
    run.start      → 开一次尝试
    run.event      → turn.start、step.start、step.finish、turn.finish 给出顺序和状态
    run.end        → 关掉这次尝试
第二遍：把内容盖上去
  for 每条 note.step.settled
    settled[stepId] = content                   // 最后一条为准
```

结构来自 `stream.run.event`。内容来自 `note.step.settled`。两者都要，谁也替不了谁。

日常浏览仍然读 `turn` 和 `step`。流水坏了不影响浏览，坏行也污染不了回放。

## 以后改记录

增量改动是免费的。新字段、新 part 类型、新的 `note.*` 成员、新的 `AgentStreamEvent`，现有读者都解析得了。

三条规矩让这件事成立：

1. **不认识即不透明。** 读者跳过不认识的族，原样保留不认识的成员，绝不抛错。没有这条，加一种事件就会让所有老会话的回放同时炸掉。
2. **delta 过滤名单是一张「跳过什么」的清单，只有一处。** 新的类 delta 事件没人加进清单，就要拿磁盘付账。
3. **新增生效值要升 `v`。** 它不重写旧行，因为 `v` 在每一行上。读到 `v: 1` 的读者显示「这份记录没有这一项」。填个默认值就是在替过去撒谎。

改动一个回合或一个步骤的**含义**不属于增量。旧记录那时按原样显示，不按新规则解释。流水存发生过什么，不存它是什么意思。

## 敏感文本

记录按原样写。机器是用户自己的。脱敏属于出口：导出或上报时才去掉不能离开这台机器的东西。那件事等需求。

## 不做

导出路由、脱敏、复活 tape、从流水开新会话、保留期，以及把流水搬进数据库。

## 测试

两个缝。

- **文件边界。** 追加记录、读回来、得到同样的记录。最后一行截断时被丢掉，中间坏行被跳过并计数。
- **一次运行的回放。** 用 `fake-provider` 录一次运行，投影它，得到和直播时一样的时间线。这是唯一能判定这个功能是否成立的度量。
