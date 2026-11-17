# 录制带与可步进回放

调试只在运行期间成立的界面很难：插话与排队、审批、重试、压缩、任务通知，都要一个
真实的运行窗口。今天的办法是让假供应商慢一点，然后靠猜秒数抢那个窗口
（[e2e/batching.e2e.ts](../../e2e/batching.e2e.ts) 用 `slow-answer` 的三秒）。

这个方案把窗口变成可以停住的东西：供应商的真实流录成一条**录制带**，之后原速播放、
逐帧步进、中途挂起。它同时是 e2e 的确定性来源。

范围到「让界面停在任意一帧」为止。不做帧级倒退，不做工具副作用的重放。

## 决策

| 决策       | 结论                                                  |
| ---------- | ----------------------------------------------------- |
| 归属       | `packages/agent/src/testing/tape/`，独立于假供应商    |
| 消费者     | 脚本驱动优先；面板是薄壳                              |
| 录制层     | HTTP 字节 + SSE 事件边界索引                          |
| 范围       | 整会话                                                |
| 工具结果   | 随下一次请求体自然录下，不单独录                      |
| 步进       | 按帧步进；调界面时关节流                              |
| 挂起       | SSE 注释行保活，上限 30 分钟                          |
| 空闲       | 阈值压缩，默认 2 秒                                   |
| 接管       | 输入即接管，单程                                      |
| 时间轴执行 | server 侧的 dev 重放器                                |
| 面板       | 先由供应商提供（`/__tape/panel`）；重放器落地后跟着搬 |

决策的理由见 [ADR 0017](../adr/0017-tapes-record-external-input.md)。

## 领域词

`packages/agent/GLOSSARY.md` 加了五条：**录制带**、**帧**、**播放**、**挂起**、**接管**。
注意「播放」与「回放」不是一个词：回放一次交出整条响应，播放可以停在任意帧。
「挂起」与「暂停」也不是：暂停是运行器不再起跑，挂起时运行还在跑。

## 格式

文件是 JSONL，一行一个 `TapeItem`，只追加。第一行是头，带版本号；读到别的版本就
拒绝，不做静默降级。一次会话几十分钟，整份读改写会越来越慢；现有的 `Recorder`
每次全量 `writeFile`（[record.ts:45](../../packages/agent/src/testing/fake-provider/record.ts#L45)），
整会话场景下不合适。

```ts
export type TapeItem =
  | { kind: "header"; version: 1; startedAt: string }
  | { kind: "request"; at: number; entry: TapeEntry }
  | { kind: "input"; at: number; input: TapeInput };

export type TapeInput = {
  type: "user" | "approval" | "timer";
  /** 已脱敏的一句话描述，只给人看。 */
  summary: string;
};

export type TapeEntry = {
  request: {
    method: string;
    path: string;
    stream: boolean;
    model?: string;
    /** 请求体；脱敏模式下换成 digest 与长度。 */
    body?: string;
    bodyDigest?: string;
    bodyBytes?: number;
  };
  response: {
    status: number;
    headers: Record<string, string>;
    frames: TapeFrame[];
    /** 第 i 个事件在哪个帧结束。值可以重复。 */
    eventFrames: number[];
    /** 最后一帧到响应结束的间隔。 */
    tailMs: number;
  };
};

export type TapeFrame = {
  /** 相对本条响应开始。 */
  at: number;
  /** base64 编码的原始字节。 */
  bytes: string;
};
```

`at` 有两级：`item.at` 相对会话开始，`frame.at` 相对响应开始。

`eventFrames` 是索引不是切分：它是一个查找表，用来支持「播到下一个事件」；原始字节
始终是唯一真相。一个事件可以跨两帧，一帧也可以结束两个事件。

`bytes` 不重组：回放时原样写出。帧按 base64 存，因为上游的 chunk 边界可能切在 UTF-8
多字节字符中间；按文本存，JSON 序列化会把坏掉的那几个字节换成 U+FFFD，拼不回来。

### 脱敏

`--redact` 时 `body` 换成 `bodyDigest` 与 `bodyBytes`。回放不按内容匹配请求，顺序就是
形状，所以摘要足够。这条取舍与现有 `replay` 动作一致（[ADR 0011](../adr/0011-fake-provider-decouples-scenarios-from-protocols.md)）。

## 录制

挂在现有 `proxy` 上（[index.ts:190](../../packages/agent/src/testing/fake-provider/index.ts#L190)），
只改两处：

```ts
const startedAt = performance.now();
for await (const piece of upstream.body ?? []) {
  frames.push({
    at: Math.round(performance.now() - startedAt),
    bytes: encodeFrameBytes(Buffer.from(piece)),
  });
  response.write(piece);
}
```

写完再扫一遍事件边界：累加 `bytes`，找 `\n\n`，记下每个事件结束在哪个帧。纯索引，
不改字节。

请求体自己留着——工具结果就在里面，不需要第二条通道。

用户输入与审批发生在 server 进程，请求与响应发生在供应商进程。为了让录制带只有一个
写入方，server 侧的重放器通过控制面把事件推进来：

```text
POST /__tape/input  { type: "user", summary: "把 notes.md 的标题改一下" }
```

供应商收到就追加一行。文件始终由一个进程写，不会交错。

入口：

```bash
vp run fake:provider -- \
  --record https://api.deepseek.com/v1 \
  --tape packages/agent/scenarios/tapes/my-session.jsonl \
  --redact
```

`--tape` 要配 `--record`：没有上游，就没有帧可记。只给 `--record` 时仍写旧格式；
同时给两个时默认只写录制带，要两份就显式加 `--out`。

入仓的样本放 `scenarios/tapes/`（少量、脱敏）；`scenarios/recorded/` 继续在
`.gitignore` 里，留给本地录制。

## 播放

时间只由一个东西决定：`Clock`。

```ts
export type Clock = {
  /** 等第 index 帧被允许发出；resolve 即写。 */
  next(index: number, frame: TapeFrame): Promise<void>;
};
```

两种实现：

```ts
// 原速，带阈值压缩
const wallClock = (capMs = 2_000): Clock => {
  let prev = 0;
  return {
    async next(_index, frame) {
      const gap = Math.max(0, Math.min(frame.at - prev, capMs));
      prev = frame.at;
      if (gap > 0) {
        await sleep(gap);
      }
    },
  };
};

// 人工：挂起，等 step 或 resume
const manualClock = (bus: ControlBus): Clock => ({
  async next() {
    await bus.waitRelease();
  },
});
```

播放器主循环：

```ts
for (const [index, frame] of entry.response.frames.entries()) {
  await Promise.race([clock.next(index, frame), timeout(HOLD_LIMIT_MS)]);
  response.write(frame.bytes);
  keepalive.reset();
}
```

保活：每 15 秒发一次 `: keepalive\n\n`。SSE 规范里 `:` 开头的行是注释，AI SDK 与
undici 都忽略内容，只重置 `bodyTimeout`。挂起超过 30 分钟直接结束响应。

现有的 `slow.firstChunkMs` / `chunkMs` 退化成 `wallClock` 的参数，不保留两套。

播放一份带：

```bash
vp run fake:provider -- \
  --play packages/agent/scenarios/tapes/my-session.jsonl \
  --speed 2
```

`--play` 与 `--record` 互斥。带到头之后再来的请求回一条供应商错误，和旧的 `replay`
动作一致。

要让它在某一帧停住，加 `--pause-at`：

```bash
vp run fake:provider -- \
  --play packages/agent/scenarios/tapes/my-session.jsonl \
  --pause-at 2
```

`--pause-at` 是 0 基，指的是已经发出的帧数：`2` 表示前两帧写完、第三帧之前停下。
连接保持打开、不发数据，所以客户端看到的是「还在生成」。日志打
`paused at frame 2`，`POST /__tape/resume` 放行。

## 控制面

和数据面同端口。P2 已经落地的：

```text
GET  /__tape/state            → { tape, position, remaining, frames, mode, paused }
POST /__tape/pause            → 下一帧起挂起
POST /__tape/step             → 放一帧，然后回到挂起
POST /__tape/resume           → 完全放行
POST /__tape/load    { path } → 换带；播放中 409
POST /__tape/input   { type, summary }  → 录制时追加一条输入事件
```

`mode` 是 `run` / `hold` / `step` 三种。`step` 在没有等待者时留给下一次，播放器下次
`wait` 就用掉它，所以连点两次不会丢帧。

还留在后面：

```text
GET  /__tape/tapes            → 可用带的清单
POST /__tape/rewind           → 同一条从头再来
POST /__tape/speed   { x }    → 0.1 到 10
POST /__tape/takeover         → 分叉，之后转实时
```

换带必须配新会话：带是「一次会话的外部输入」，换带就是换历史。旧会话已经有自己的
记录，拿新带喂它只会错位。A/B 对比两条带时起两个实例，不要在一个进程里来回切。

## 时间轴执行

时间轴要写收件箱，而供应商不知道会话是谁。所以执行者是 server 侧的 dev 重放器：

```text
Server（重放器）                 Provider
  读录制带                        只按请求回放响应
  按 at 投递 input
  控制播放节奏 ─────────────────→ Clock
```

`input` 项真的写进收件箱，否则整会话回放只有 assistant 的消息，时间轴是断的。

## 接管

```text
用户发消息 → 运行器照常入队
          → 重放器 POST /__tape/takeover
          → 播放器结束当前响应（正常收尾）
          → 之后的请求转发给真供应商
```

单程，不提供回到录制的入口。判据放在下一条请求：游标已耗尽或已接管，就走代理。

## 三条边界

| 边界                 | 事实                                                                                                    | 对策                     |
| -------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------ |
| undici `bodyTimeout` | 默认 `300_000` ms，实测 300.7 秒断开                                                                    | 注释保活                 |
| 前端渲染节流         | `throttleMs = 200`（[use-agent-session.ts:365](../../packages/ui/src/hooks/use-agent-session.ts#L365)） | 按数据步进；调试时关节流 |
| SSE 单向             | 帧发出去收不回来                                                                                        | 面板不给「上一帧」       |

## 分阶段

| 阶段 | 内容                          | 完成标志                  |
| ---- | ----------------------------- | ------------------------- |
| P0   | 格式 + JSONL 录制             | 录出一份能读懂的带        |
| P1   | 播放器 + `wallClock`          | 同一份带播两次，界面一致  |
| P2   | 控制面 + `manualClock` + 面板 | 能停在工具调用那一帧      |
| P3   | 保活 + 空闲压缩 + 接管        | 挂起 10 分钟不断          |
| P4   | e2e 迁移                      | 删掉 `slow-answer` 的三秒 |

P0、P1、P2 都落地了。面板在 `GET /__tape/panel`，由供应商提供——重放器还没写，
先让播放控制能用。它还没有在真实会话上跑过一遍。

## 风险

- **录制带是 PII。** 请求体带提示词。入仓前必须脱敏，`scenarios/tapes/` 配一个检查脚本。
- **两套读法并存。** 旧 `replay` 动作与新播放读同一类文件。P1 之后把旧动作标成 deprecated。
- **输入事件靠 server 侧的钩子推。** 钩子漏了，时间轴上就少一条，回放会显得不完整。
  它必须是 dev-only 的，且不能改变生产路径。
