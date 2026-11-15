# 假供应商方案

今天没有人替供应商说话。自动测试把 `streamText` 换掉，绕过了 HTTP、SDK 的协议解析
和真实的重试次数；手动验证靠一次性脚本，用完就丢。结果是：`gateway.ts` 到
`createOpenAICompatible(...).chatModel` 这一段，一个测试都没走过；`Retry-After`
真的生效，是靠人点出来的。

这个方案做一个**假供应商**：一个按供应商协议应答的本地服务。手动能点着看，测试能
起它跑，两边共用同一份场景。失败写成 JSON。录制能把一次真流留下来，之后任意次
回放，不再花 token。

使用说明见 `docs/testing/fake-provider.md`。

## 决策

| 决策         | 结论                                                          |
| ------------ | ------------------------------------------------------------- |
| 服务谁       | 手动和自动共用一套场景；场景是唯一来源                        |
| 位置         | `packages/agent/src/testing/fake-provider/`，显式导出一条入口 |
| 场景         | `packages/agent/scenarios/*.json`，zod 校验                   |
| 选择规则     | 顺序为主，可选 `when` 匹配器                                  |
| 动作         | `fail`、`failMidStream`、`slow`、`reset`、`corrupt`           |
| 录制回放     | 做。代理模式录真流，按顺序回放                                |
| 回放匹配     | 按顺序取，不按请求内容匹配                                    |
| 协议         | 先做 `openai-chat`；`openai-responses` 以后加写手             |
| 起停         | 每个用例自己 `listen(0)`，结束关闭                            |
| 逃生口       | 不留 `raw`；扩展的单位是「加一个动作」                        |
| 产品里的位置 | 不进设置预设。手动测试就是加一个自定义供应商                  |
| 词表         | 不进 `GLOSSARY.md`；工具自带 README                           |

## 场景

场景是数据，不是代码。一个 JSON 描述「第几次请求做什么」。

```json
{
  "name": "retry-then-succeed",
  "rules": [
    { "fail": 429, "retryAfter": 2 },
    { "fail": 429, "retryAfter": 2 },
    { "answer": "重试成功，这是第 3 次请求。" }
  ]
}
```

给的例子是最常见的形状：前两次失败，第三次回答。规则按顺序消费；带 `when` 的规则
只在匹配时消费。

```json
{
  "name": "title-does-not-eat-a-failure",
  "rules": [
    { "when": { "stream": true }, "fail": 503 },
    { "answer": "标题不该消耗失败次数", "when": { "stream": false } }
  ]
}
```

这个匹配器不是装饰。第一版手动验证踩过一个坑：会话的标题生成也走同一个供应商，
它把 `--failures 2` 的第一次失败吃掉了，人只看到一行重试，差点以为是 bug。把它写进
语言里，坑就只踩一次。

## 动作

| 动作            | 线上发生什么                                                    |
| --------------- | --------------------------------------------------------------- |
| `fail`          | 回状态码，带可选的 `Retry-After` / `retry-after-ms` 头          |
| `failMidStream` | 先发 n 个块，再发 `{"error":{...}}`；SDK 会把它归一成供应商错误 |
| `slow`          | 首块延迟、块间隔                                                |
| `reset`         | 直接断开连接                                                    |
| `corrupt`       | 发一段非法 JSON，制造解析失败                                   |
| `answer`        | 正常流式回答                                                    |
| `replay`        | 从录制里取下一条响应，原样写出                                  |

`failMidStream` 的形状有依据：`@ai-sdk/openai-compatible` 收到 `data: {"error":{...}}`
会发一个 `error` 块，`streamText` 再用 `normalizeStreamProviderError` 把它变成
`StreamProviderError`——`statusCode` 从 `statusCode` / `code` / `status` 取，没有就按
消息文本猜（`"overloaded"` → 503、可重试），也认显式的 `isRetryable`。所以这个动作
能精确控制「一条流内错误算不算可重试」。

## 分层

场景说意图，写手说表达。协议知识只活在写手里。

```
场景 JSON（协议无关）
   └─ 规则：动作 + 可选 when
        └─ 写手：chat-completions（现在）｜responses（以后）
              fail          → HTTP 状态码 + Retry-After
              failMidStream → 若干块 + {"error":{...}}
              slow          → 定时器夹在块之间
              reset         → socket.destroy()
              corrupt       → 非法 JSON
```

加协议 = 加一个写手，场景一个都不用改。加失败 = 动作表加一项，每个写手加一个分支；
某个协议表达不了的，就在写手里报「这个动作不支持」。

## 录制与回放

录制开代理模式：假供应商把请求转给真供应商，把响应原样 tee 到文件。之后回放时
`replay` 动作按顺序取。

三条必须写下来的规矩：

1. **录的是序列，不是单条。** 一次带工具的回合会发多次请求（要工具 → 拿结果 →
   回答）。按「下一次请求取下一组」存，天然装得下；单条响应的格式装不下。
2. **审批不需要特殊支持。** 审批是宿主动作，供应商只看得到两次请求，中间那段时间
   它不知道。批准和拒绝都只改变下一条请求的内容，照样被录下来。唯一的要求是录制
   进程别在暂停期间退出；重启后用 `--append` 续写。
3. **回放会重跑副作用。** 回放不是录播：工具在宿主机上会再执行一遍。要没有副作用，
   把工具也换成假的（测试里 `agent.registerTool` 的做法）。

fixtures 默认落在被 gitignore 的目录（`packages/agent/scenarios/recorded/`），因为里面
带着提示词与答案。只有挑过、脱敏过的才入仓。

## 模块

| 路径                                                | 职责                                                    |
| --------------------------------------------------- | ------------------------------------------------------- |
| `packages/agent/src/testing/fake-provider/index.ts` | 起停：`startFakeProvider(scenario)`                     |
| `.../scenario.ts`                                   | zod 场景、加载器、按名查找                              |
| `.../rules.ts`                                      | 规则消费：顺序 + `when` 匹配                            |
| `.../writers/chat-completions.ts`                   | 动作 → HTTP/SSE                                         |
| `.../record.ts`                                     | 代理模式：转发、tee、追加                               |
| `.../cli.ts`                                        | `--scenario`、`--port`、`--record`、`--out`、`--append` |
| `packages/agent/scenarios/*.json`                   | 场景文件                                                |
| `packages/agent/package.json`                       | 加一条显式导出 `./testing/fake-provider`                |
| 根 `package.json`                                   | 加 `fake:provider` 脚本                                 |

## 测试

- 替身自己的契约测试：每个动作在线上产生什么（状态码、头、块的形状）。
- 写手测试：同一份场景，chat completions 写出来的字节符合预期。
- 内核用法测试（第二个 PR）：用替身跑一次真实的 `streamText`，证明流中途的可重试
  错误确实会触发重试、`Retry-After` 确实决定等待时长。这是这条路线上第一组真测试。
- 每个用例自己 `listen(0)` 起、结束关；场景的顺序状态不跨用例共享。

## 不做

- 不进设置预设。预设是产品词汇，混进一个假供应商等于让产品代码认识测试设施。
- 不进 `GLOSSARY.md`。词表是产品语言；先例是沙箱的 `src/testing/fake.ts` 没有进
  `packages/sandbox/GLOSSARY.md`。哪天它变成产品的一部分，再进。
- 不模拟工具调用与审批的模型侧形状（第二阶段）。那是内核的关注点。
- 不做 `openai-responses`（以后加写手）。
- 不留 `raw` 或自定义写手逃生口。扩展的单位是「加一个动作」。
- 不做通用 chunk 脚本。场景可读是它存在的理由。

## 验收

- 手动：`node --import tsx packages/agent/src/testing/fake-provider/cli.ts --scenario retry-then-succeed`
  起服务；设置里加一个自定义供应商指过去；发一句话，看到两行重试和一条答复。
- 手动：`--scenario title-does-not-eat-a-failure` 时，标题请求不被计为一次失败。
- 手动：`--record` 指向真供应商，产出 fixtures；同一场景用 `replay` 回放，不再请求
  真供应商。
- 自动：替身契约测试与写手测试通过；`vp check` 0 错误。
- 审批：录制一条带审批的交互，回放时停在 `wait_review`，批准后继续。

## 分步实施

拆两个 PR。

1. **替身本体**：场景与校验、规则消费、chat completions 写手、五个动作、CLI、录制。
   加契约测试与写手测试。不碰内核。
2. **第一个使用场景**：用替身验 `AIFY0-69` 的两处盲区——流中途的可重试错误、真实
   `Retry-After` 对等待时长的影响。这一步会真的经过 `gateway.ts` 与 SDK，是这条路
   线上第一组测试。
