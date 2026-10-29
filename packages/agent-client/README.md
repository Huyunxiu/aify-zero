# 事件装配（agent-client）

把 agent 流事件装配成 `turn → step → part` 树。服务端用它决定落库的 step，浏览器用它决定渲染的 transcript；两边跑的是同一份代码。

## 结构

| 名称                 | 职责                                                                                                           |
| -------------------- | -------------------------------------------------------------------------------------------------------------- |
| `AgentTurnAssembler` | 索引、分发、变更记账。不认识具体 part 类型                                                                     |
| `AssemblerModule`    | 一组事件处理；内置 9 个模块（turn、step、text、reasoning、custom、session-title、tool、compaction、lifecycle） |
| `AssemblerContext`   | 模块能用的全部操作：查/插 turn 与 step、追加 part、打开或关闭流式 part、工具索引、变更记账                     |

分发是一张表：`push` 按事件类型取 handler。`custom` 事件先按 `custom:<kind>` 找，找不到再回退到核心的 `custom` handler，所以没被认领的 kind 仍然落成不透明的 `custom` part。

## 不变量

1. **`push` 串行 `await`。** 事件顺序就是到达顺序；`tool.input-delta` 会在 handler 里等待部分 JSON 解析，并行派发会让解析互相覆盖。
2. **流式 part 只能通过 `ctx.openPart` 建立。** 它同时把 part 追加进 step 并登记收尾动作；那个回调是 `settle` 唯一需要知道的东西：text 置 `done`，compaction 撤回 part 和空 step。
3. **一个 turn 的模块集合在构造时固定。** 中途加载或卸载只影响下一个 turn。`resume` 从 `turn.start` 重放整个 turn，集合变了，重放结果就和首次装配不一致。
4. **tool part 不进 `openParts`。** 它有自己的状态机，`settle` 不动它。
5. **注册时只查能查的冲突。** 重复模块名、重复事件键、扩展认领协议事件键，都会在注册时抛错；键名写错在运行期无法判断，只能靠类型检查。

## 新增一个协议事件

协议事件属于装配包本身，三处改动，其中一处由编译器盯着你：

1. `src/types.ts`：定义事件类型，并加进 `AgentStreamEvent` 联合。
2. `src/agent-turn-assembler.ts`：在对应模块的 `events` 里补 handler。漏了会让 `MissingHandlers` 编译失败，报错直接点名事件类型。
3. 如果事件产出新的 part：把它加进 `AgentPart` 联合，并在服务端的投影（`packages/agent/src/compaction/project.ts`）和 UI 渲染器里各补一处。

## 新增一个模块自己的事件

运行期加载的扩展用 `custom` 携带自己的事件，不改协议联合：

```ts
api.assembler({
  name: "plan",
  events: {
    "custom:plan.updated": (ctx, event) => {
      // event 是 custom 事件，kind 已经确认
    },
  },
});
```

- 键只能是 `custom:<kind>`；协议事件由核心模块装配，扩展不能替换。
- 同一个 `kind` 只能被一个扩展认领，冲突在扩展加载时抛错。
- 模块名按扩展命名空间成 `扩展id/模块名`，两个扩展可以有同名模块。
- handler 抛错会被捕获并记日志，不中断这一轮对话。

扩展装配只在服务端进程里跑。它产出的形状必须客户端也能装配——否则流式期间客户端会退化成不透明的 `custom` part，重载后才从库里读到服务端的装配结果。

## 校验

| 时机   | 机制                                           | 拦什么                                   |
| ------ | ---------------------------------------------- | ---------------------------------------- |
| 编译期 | `MissingHandlers<Missing>`（`coreAssemblers`） | 内置模块漏了某个事件                     |
| 运行期 | `warnUnhandled`                                | 服务端与客户端版本偏移，来了不认识的事件 |
