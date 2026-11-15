# 假供应商

按 chat completions 协议应答的本地服务。手动能点着看，测试能起它跑，两边读同一份
场景。它替的是供应商，不是内核。

```bash
# 手动：起服务，然后在设置里加一个自定义供应商，baseURL 指向打印出来的地址
vp run fake:provider -- --scenario retry-then-succeed

# 测试：自己 listen(0)，结束关闭
const provider = await startFakeProvider({ scenario: "retry-then-succeed" });
```

## 场景

场景是 `packages/agent/scenarios/*.json`，协议无关：只说第几次请求做什么。

```json
{
  "name": "retry-then-succeed",
  "rules": [
    { "when": { "stream": false }, "answer": "假标题" },
    { "when": { "stream": true }, "fail": 429, "retryAfter": 2 },
    { "when": { "stream": true }, "answer": "重试成功。" }
  ]
}
```

规则按文件顺序消费；条件对不上的不消费，留着等下一次请求。

| 结果            | 线上发生什么                                           |
| --------------- | ------------------------------------------------------ |
| `answer`        | 正常流式回答，按字符分块                               |
| `fail`          | 回状态码，可带 `retryAfter` / `retryAfterMs`           |
| `failMidStream` | 先发 `text`，再发 `{"error":{...}}`                    |
| `replay`        | 从录制里取下一条响应，原样写出；可反复用，直到录制用完 |
| `reset`         | 直接断连接                                             |
| `corrupt`       | 发一段非法 JSON                                        |

修饰：`slow.firstChunkMs`、`slow.chunkMs`、`when.stream`、`when.model`。

## 录制

```bash
vp run fake:provider -- \
  --record https://api.deepseek.com/v1 \
  --header "authorization=Bearer $KEY" \
  --out packages/agent/scenarios/recorded/deepseek-429.json
```

代理模式把响应原样转发并落盘，一条一条写。录完把场景里的规则换成
`{ "replay": "recorded/deepseek-429.json" }`，就不再请求真供应商。录制默认落在
`.gitignore` 的目录里：它带着你的提示词与答案。

## 四个坑

1. **标题请求会吃掉失败次数。** 会话标题也用同一个供应商，是非流式的。用
   `when: { stream: true }` 把对话的规则和非流式的规则分开。
2. **流中途的错误必须是 `data: {"error":{...}}`。** 只有这样 SDK 才会把它归一成
   `StreamProviderError` 并按 `statusCode` / 消息文本分类；发别的形状会变成另一种错误。
3. **审批 id 不是供应商给的。** 它是内核自己生成的（`tools/execution.ts`），所以回放
   不需要保持它。
4. **回放会重跑副作用。** 工具会在宿主机上再执行一次。要没有副作用，把工具也换成假的。

## 为什么没有 `raw`

扩展的单位是「加一个动作」。`raw` 看起来省事，实际会把场景变成没人愿意读的协议草图，
而场景可读是它存在的理由。取舍见 `docs/adr/0011-fake-provider-decouples-scenarios-from-protocols.md`。
