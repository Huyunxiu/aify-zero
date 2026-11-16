# 测试供应商行为

要验「供应商出错时应用怎么反应」时看这一页：重试、失败提示、慢流、流中途报错、
录制回放。假供应商是一个按 chat completions 应答的本地服务，手动能点着看，测试能
起它跑，两边读同一份场景。

工具本身在 `packages/agent/src/testing/fake-provider/`，场景格式、动作表、命令行
参数见那里的 [README](../../packages/agent/src/testing/fake-provider/README.md)。
这一页讲怎么用它测。

## 四层，各管一件事

| 层             | 命令                                       | 管什么                                              |
| -------------- | ------------------------------------------ | --------------------------------------------------- |
| 格式与静态检查 | `vp check`                                 | 类型、lint、格式                                    |
| 内核判定       | `vp test run packages/agent/tests/kernel`  | 预算、判定、编号、状态流转；`streamText` 被换掉，快 |
| 协议与 HTTP    | `vp test run packages/agent/tests/testing` | 真发几次请求、`Retry-After` 怎么读、流块怎么映射    |
| 人的眼睛       | 假供应商 + `vp dev`                        | 屏幕上的样子、等待的手感                            |

前两层改一次跑几秒；第三层也是秒级；第四层才是「手感」。

## 手动走一遍

**终端 1，起替身：**

```bash
vp run fake:provider -- --scenario retry-then-succeed --port 4030
```

它打印 `[fake-provider] baseURL=http://127.0.0.1:4030/v1  scenario=retry-then-succeed`。

**终端 2，起应用：**

```bash
vp dev
```

打开它打印的登录链接。

**在应用里配一个供应商。** 设置 → 供应商 → 自定义：

- baseURL：`http://127.0.0.1:4030/v1`
- 密钥：随便填，假供应商不校验
- 点「拉取」，选它给出的模型

**发一句话。** 然后看终端 1。

## 替身的日志是唯一的真相

屏幕只告诉你结果，替身告诉你应用到底发了几次、每次拿到什么。

```text
[fake] POST /v1/chat/completions stream=false model=fake-fast
[fake] -> answer
[fake] POST /v1/chat/completions stream=true  model=fake-fast
[fake] -> fail 429
[fake] POST /v1/chat/completions stream=true  model=fake-fast
[fake] -> fail 429
[fake] POST /v1/chat/completions stream=true  model=fake-fast
[fake] -> answer
```

第一行是非流式请求：会话的标题生成也走同一个供应商。一条 `stream=true` 就是一次
真正的模型调用，所以上面是「失败两次、重试两次、成功」。

## 七个场景，各自该看到什么

| `--scenario`                   | 替身的日志                            | 屏幕                                                                                    |
| ------------------------------ | ------------------------------------- | --------------------------------------------------------------------------------------- |
| `retry-then-succeed`           | answer → fail 429 → fail 429 → answer | `Retry 1/5`、`Retry 2/5`，各约 2 秒（来自 `Retry-After: 2`），然后答案                  |
| `mid-stream-error`             | answer → fail mid-stream → answer     | 先出现半句「先给你半句，」，再 `Retry 1/5`（约 2 秒退避，没有头），然后「这次说完了。」 |
| `unauthorized`                 | answer → fail 401                     | 立刻 `Failed`，没有重试行                                                               |
| `title-does-not-eat-a-failure` | answer → fail 503 → answer            | `Retry 1/5`，然后答案                                                                   |
| `slow-stream`                  | answer                                | 空白约 1.5 秒才出第一个字                                                               |
| `broken-stream`                | answer → corrupt                      | `Failed`，没有重试；畸形块不是供应商错误，本来就不该重试                                |
| `edit-then-answer`             | answer → toolCall → answer            | 先出现一行 `Edit notes.md` 与 `+1 −1`，再出答案；改动视图能列出这个文件                 |

规则按顺序消费，所以重启替身就从头再走一遍。

## 录制回放

真供应商的响应可以录一次，之后免费回放，包括真实的 429 body 和流中途错误。

```bash
vp run fake:provider -- \
  --record https://api.deepseek.com/v1 \
  --header "authorization=Bearer $KEY" \
  --out packages/agent/scenarios/recorded/deepseek.json \
  --port 4031
```

应用的 baseURL 指 `http://127.0.0.1:4031/v1`，正常聊一次。文件被逐条写出：一条
请求一条响应，顺序保留。

回放要一个场景文件，例如 `packages/agent/scenarios/replay-deepseek.json`：

```json
{
  "name": "replay-deepseek",
  "rules": [
    { "when": { "stream": false }, "answer": "假标题" },
    { "replay": "recorded/deepseek.json" }
  ]
}
```

再起 `--scenario replay-deepseek`。一条 `replay` 规则会服务到录制用完为止。

三条要注意：

- 录制的是**请求序列**。带工具的回合会发多次请求，审批暂停只是中间隔了一段时间。
- 回放会**重跑副作用**：工具在宿主机上会再执行一次。要没有副作用，把工具也换成假的。
- 录制默认落在 `.gitignore` 的 `scenarios/recorded/`；它带着你的提示词与答案，入仓
  前要挑过、脱敏过。

## 出问题时往哪看

| 现象                             | 先看哪                                                                                                                   |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 屏幕有重试行，替身只收到一次请求 | 应用终端的 `agent#runStep`；第一次请求可能根本没发出去                                                                   |
| 屏幕没有重试行，替身收到两次请求 | 记录或界面：装配器、`assistant-message`                                                                                  |
| 等待时间对不上                   | 退避是 2 / 4 / 8 秒；响应头里有 `Retry-After` 时按头等。用 `mid-stream-error`（无头）和 `retry-then-succeed`（有头）对比 |
| 替身答「规则用完了」             | 场景的规则比请求少。给非流式的标题请求也留一条                                                                           |

## 自己写场景

场景是 `packages/agent/scenarios/*.json`。最小的一个：

```json
{
  "name": "mine",
  "rules": [
    { "when": { "stream": false }, "answer": "假标题" },
    { "fail": 503, "retryAfterMs": 300 },
    { "answer": "第二次就成功了。" }
  ]
}
```

规则按顺序消费；`when` 对不上的不消费，留着等下一次请求。动作表与修饰（`slow`、
`retryAfter`、`when.model`）见工具的 README。

写场景时最容易踩的一个坑：**非流式的标题请求也会来。** 不给它一条规则，它会吃掉给
对话准备的那次失败。`when: { "stream": false }` 是最省事的解法。
