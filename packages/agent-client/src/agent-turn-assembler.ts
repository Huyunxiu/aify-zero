import { parsePartialJson } from "ai";
import type { ToolSet } from "ai";

import {
  isAgentCompactionPart,
  isAgentDynamicToolPart,
  isAgentReasoningPart,
  isAgentSessionTitlePart,
  isAgentStaticToolPart,
  isAgentTextPart,
  isAgentToolPart,
} from "./types";
import type {
  AgentAssistantStep,
  AgentAssistantTurn,
  AgentCompactionPart,
  AgentCompactionStep,
  AgentCompactionTurn,
  AgentCustomContentPart,
  AgentDynamicToolPart,
  AgentPart,
  AgentReasoningPart,
  AgentSessionTitlePart,
  AgentSessionTitleStep,
  AgentStaticToolPart,
  AgentStep,
  AgentStreamEvent,
  AgentTextPart,
  AgentToolPart,
  AgentTurn,
  AgentUserStep,
  AgentUserTurn,
  TextStreamStartStepEvent,
  TextStreamStartTurnEvent,
} from "./types";

/**
 * 一个 part 在事件里的地址。
 *
 * 事件里这三个字段总是同时出现，拼出来的 key 只在装配器内部使用。
 */
export interface PartRef {
  readonly turnId: string;
  readonly stepId: string;
  readonly id: string;
}

/**
 * 事件的所有类型。
 *
 * 用 `any` 实例化：tool 事件的判别式藏在 `TypedToolCall<TOOLS>` 上的条件
 * 类型里，泛型未定的时候取不到字面量，整张表的键会塌成 `never`。`any`
 * 把它展开成具体的并集，handler 因此能按 key 收到确切的事件类型。
 */
export type AgentEventType = AgentStreamEvent<any>["type"];

/** 事件联合里某个类型的事件。 */
export type EventOf<K extends AgentEventType> = Extract<
  AgentStreamEvent<any>,
  { type: K }
>;

/** 一个模块声明处理的事件类型。 */
type CoveredEvents<M> = M extends { events: infer E } ? keyof E : never;

/** 缺的 handler：属性名是事件类型，值永远不存在。 */
type MissingHandlers<M extends string> = Record<M, never>;

/**
 * 一个事件键一个 handler；参数由类型自动收窄。
 *
 * 键有两种：协议事件类型，或模块自己的 `custom:<kind>`。后者认领的是
 * `custom` 事件里的一种 kind，所以参数类型是 `custom` 事件本身。
 */
export type AssemblerHandlerMap<TOOLS extends ToolSet> = {
  [K in AgentEventType]: (
    ctx: AssemblerContext<TOOLS>,
    event: EventOf<K>
  ) => void | Promise<void>;
} & Partial<
  Record<
    `custom:${string}`,
    (
      ctx: AssemblerContext<TOOLS>,
      event: EventOf<"custom">
    ) => void | Promise<void>
  >
>;

/**
 * 一个模块向装配器贡献的事件处理。
 *
 * 模块只拿到 {@link AssemblerContext}：它不能触发分发，也不能替换整棵
 * transcript。这样模块的边界就是它真正需要的写操作。
 */
export interface AssemblerModule<TOOLS extends ToolSet> {
  /** 模块名。重复注册会抛错，注销时按它定位。 */
  readonly name: string;
  /** 这个模块处理的事件；没列出来的事件归别的模块。 */
  readonly events: Readonly<Partial<AssemblerHandlerMap<TOOLS>>>;
  /**
   * 流中断时收尾模块自己的、不挂在 part 上的状态。
   *
   * 模块打开的 part 不需要这个钩子：`ctx.openPart` 时登记的收尾动作会被
   * 执行。只有状态不落在 part 上的模块才需要它。
   */
  readonly settle?: (outcome: "aborted" | "error") => void;
}

/**
 * 模块能拿到的全部能力。
 *
 * 方法按用途分段：树的位置、流式 part、工具调用索引、变更记账。分段只用
 * 注释表达，不再套一层命名空间——`ctx.findStep` 只是多一次跳转，方法
 * 总数一个不少。名字本身已经说明用途，扁平之后 handler 也更好读。
 */
export interface AssemblerContext<TOOLS extends ToolSet> {
  findTurn(id: string): AgentTurn<TOOLS> | undefined;
  findStep(id: string): AgentStep<TOOLS> | undefined;
  /** 按 id 插入一条 turn；已存在时只更新索引。 */
  insertTurn(turn: AgentTurn<TOOLS>): void;
  /** 把 step 挂到 turn 上并索引；turn 不存在时只索引。 */
  insertStep(turnId: string, step: AgentStep<TOOLS>): void;
  /** 追加一个不会流式更新的 part，例如 `custom`；step 不存在时丢弃。 */
  appendPart(stepId: string, part: AgentPart<TOOLS>): void;
  /**
   * 撤回一个 part：移除它；step 因此变空就连 turn 和索引一起删掉。
   *
   * 压缩失败的收尾就是这种操作。分开暴露「移除 part」和「删空 step」，
   * 会让调用方有机会漏掉后半步，在 turn 里留下一个不标记任何东西的边界。
   */
  retractPart(turnId: string, stepId: string, partId: string): void;

  /**
   * 追加一个流式 part，并登记它中断时的收尾动作。
   *
   * 追加和登记合成一步：只登记不追加，part 不会渲染；只追加不登记，中断时
   * 它会永远停在 `streaming`。`settle` 只执行这里登记的收尾动作。
   */
  openPart(ref: PartRef, part: AgentPart<TOOLS>, onSettle: () => void): void;
  /** 按地址找开着的 part；类型由调用方的 guard 收窄。 */
  findOpenPart(ref: PartRef): AgentPart<TOOLS> | undefined;
  closePart(ref: PartRef): void;
  /** 按 part id 撤销：找到就执行收尾动作并移除记录。 */
  abandonPart(partId: string): void;

  /**
   * 追加一个 tool part，并登记到工具索引。
   *
   * 索引按 `(turn, step, toolCallId)` 定位，和流式 part 分开：tool part 有
   * 自己的状态机，`settle` 不动它；而且它可能在这次流之外被更新——重载后
   * 答复审批、被挂起的调用返回结果，都要在这里找回来。
   */
  openToolPart(
    turnId: string,
    stepId: string,
    toolCallId: string,
    part: AgentToolPart<TOOLS>
  ): void;
  findToolPart(
    turnId: string,
    stepId: string,
    toolCallId: string
  ): AgentToolPart<TOOLS> | undefined;

  /** 记录一条 turn 被改动。 */
  markChanged(turnId: string | undefined): void;
}

/** 存进 handler 表的签名。单个事件的具体参数在注册处收窄。 */
type StoredHandler<TOOLS extends ToolSet> = (
  ctx: AssemblerContext<TOOLS>,
  event: AgentStreamEvent<any>
) => void | Promise<void>;

/**
 * 把流事件装配成 turn / step / part 树。
 *
 * 分发是一张表：每个事件类型一个 handler，handler 按模块注册。装配器本身
 * 只知道 turn 与 step 的索引、开着的 part 和变更记账；具体 part 怎么长、
 * 怎么收尾，由注册进来的模块决定。
 */
export class AgentTurnAssembler<TOOLS extends ToolSet> {
  turns: AgentTurn<TOOLS>[];
  private readonly turnsMap: Map<string, AgentTurn<TOOLS>>;
  private readonly stepsMap: Map<string, AgentStep<TOOLS>>;
  private readonly toolPartMap: Map<string, AgentToolPart<TOOLS>>;
  /**
   * 本流打开、尚未结束的 part，按 {@link PartRef} 拼出的 key 存。
   *
   * `settle` 遍历它执行收尾动作，因此新增流式 part 不需要改 `settle`。
   */
  private readonly openPartMap: Map<
    string,
    { part: AgentPart<TOOLS>; onSettle: () => void }
  >;
  /**
   * 流改动过的每一条 turn，按第一次被改动的顺序排列。
   *
   * 已经结束的 turn 只是其中一种：事件可能落在早就结束的 turn 上——一条
   * `tool.result` 会改写当初被挂起的那个 turn——所以要把 transcript 写回去的
   * 调用方不能只看结束事件。
   *
   * 每条 turn 按引用持有且只记录一次，后来读取的人看到的是它此刻的样子，
   * 而不是它第一次被改动时的样子。
   */
  changedTurns: AgentTurn<TOOLS>[] = [];
  private readonly changedTurnIds = new Set<string>();

  /**
   * 本流改动过、且最后一次改动还没有落库的 step，按第一次被改动的顺序排列。
   *
   * turn 头部和 step 整行分开记账：step 的 `content` 是一条 turn 里最大的
   * 载荷，按 turn 回写会把没变的 step 也重写一遍。写入方写成功后用
   * {@link markStepPersisted} 清掉，剩下的正好是回合结束时要兜底补写的那几条。
   */
  changedSteps: { turnId: string; stepId: string }[] = [];
  private readonly changedStepIds = new Set<string>();

  private readonly handlers = new Map<string, StoredHandler<TOOLS>>();
  /** 事件类型归哪个模块；注销和冲突检查都用它。 */
  private readonly handlerOwners = new Map<string, string>();
  private readonly moduleSettlers = new Map<
    string,
    (outcome: "aborted" | "error") => void
  >();
  private readonly modules = new Map<string, AssemblerModule<TOOLS>>();
  /** 未知事件只警告一次：版本偏移时不要让同一句话刷满日志。 */
  private readonly warnedTypes = new Set<string>();

  private readonly ctx: AssemblerContext<TOOLS>;

  /**
   * 取一个已经由事件建立起来的 step。
   *
   * 存储层用它在事件到达后读取 step 的最新快照；unknown id 返回 undefined。
   */
  getStep(stepId: string): AgentStep<TOOLS> | undefined {
    return this.stepsMap.get(stepId);
  }

  /**
   * 记录一个 step 已经落库。
   *
   * 只清掉这一条：之后再有事件改它，`push` 会重新记上。写失败时不要调用它，
   * 回合结束的兜底写入会重试。
   */
  markStepPersisted(stepId: string): void {
    if (!this.changedStepIds.delete(stepId)) {
      return;
    }

    const index = this.changedSteps.findIndex(
      (changed) => changed.stepId === stepId
    );
    if (index !== -1) {
      this.changedSteps.splice(index, 1);
    }
  }

  constructor({
    turns,
    assemblers = [],
  }: {
    turns: AgentTurn<TOOLS>[];
    assemblers?: readonly AssemblerModule<TOOLS>[];
  }) {
    this.turns = turns;
    this.toolPartMap = new Map<string, AgentToolPart<TOOLS>>();
    this.openPartMap = new Map();
    this.turnsMap = new Map<string, AgentTurn<TOOLS>>();
    this.stepsMap = new Map<string, AgentStep<TOOLS>>();

    for (const turn of turns) {
      this.turnsMap.set(turn.id, turn);
      for (const step of turn.content) {
        this.stepsMap.set(step.id, step);
        for (const part of step.content) {
          if (isAgentToolPart(part)) {
            this.toolPartMap.set(
              toolPartKey(turn.id, step.id, part.toolCallId),
              part
            );
          }
        }
      }
    }

    this.ctx = {
      findTurn: (id) => this.turnsMap.get(id),
      findStep: (id) => this.stepsMap.get(id),
      insertTurn: (turn) => {
        if (!this.turnsMap.has(turn.id)) {
          this.turns.push(turn);
        }
        this.turnsMap.set(turn.id, turn);
      },
      insertStep: (turnId, step) => {
        const turn = this.turnsMap.get(turnId);
        if (turn) {
          (turn.content as AgentStep<TOOLS>[]).push(step);
        }
        this.stepsMap.set(step.id, step);
      },
      appendPart: (stepId, part) => {
        this.appendPart(stepId, part);
      },
      retractPart: (turnId, stepId, partId) => {
        this.retractPart(turnId, stepId, partId);
      },
      openPart: (ref, part, onSettle) => {
        this.appendPart(ref.stepId, part);
        this.openPartMap.set(partRefKey(ref), { part, onSettle });
      },
      findOpenPart: (ref) => this.openPartMap.get(partRefKey(ref))?.part,
      closePart: (ref) => {
        this.openPartMap.delete(partRefKey(ref));
      },
      abandonPart: (partId) => {
        for (const [key, entry] of this.openPartMap) {
          if (!("id" in entry.part) || entry.part.id !== partId) {
            continue;
          }
          this.openPartMap.delete(key);
          entry.onSettle();
          return;
        }
      },
      openToolPart: (turnId, stepId, toolCallId, part) => {
        this.appendPart(stepId, part);
        this.toolPartMap.set(toolPartKey(turnId, stepId, toolCallId), part);
      },
      findToolPart: (turnId, stepId, toolCallId) =>
        this.toolPartMap.get(toolPartKey(turnId, stepId, toolCallId)),
      markChanged: (turnId) => {
        this.markChanged(turnId);
      },
    };

    // 内置模块走和外部模块同一条路：只有一个注册入口。
    for (const assembler of coreAssemblers<TOOLS>()) {
      this.registerAssembler(assembler);
    }
    for (const assembler of assemblers) {
      this.registerAssembler(assembler);
    }
  }

  /**
   * 注册一个模块。
   *
   * 重复的模块名，或两个模块抢同一个事件类型，都会抛错：这两种错误都只能
   * 在注册时发现，等到流跑到一半才发现就已经晚了。返回注销函数。
   */
  registerAssembler(
    module: AssemblerModule<TOOLS>,
    { replace = false }: { replace?: boolean } = {}
  ): () => void {
    if (!replace && this.modules.has(module.name)) {
      throw new Error(
        `AgentTurnAssembler#registerAssembler module "${module.name}" is already registered`
      );
    }
    if (replace) {
      this.unregisterAssembler(module.name);
    }

    for (const [type, handler] of Object.entries(module.events)) {
      // 键的类型由模块声明保证；这里只防住不是函数的输入。
      if (typeof handler !== "function") {
        continue;
      }

      const owner = this.handlerOwners.get(type);
      if (owner && !replace) {
        throw new Error(
          `AgentTurnAssembler#registerAssembler event "${type}" is already handled by module "${owner}"`
        );
      }

      // 注册时 handler 的参数是确切的事件，表按 key 存、按 key 取，所以
      // 这里放宽一次；收窄发生在注册处，不在分发处。
      this.handlers.set(type, handler as StoredHandler<TOOLS>);
      this.handlerOwners.set(type, module.name);
    }

    if (module.settle) {
      this.moduleSettlers.set(module.name, module.settle);
    }
    this.modules.set(module.name, module);

    return () => {
      this.unregisterAssembler(module.name);
    };
  }

  private unregisterAssembler(name: string): void {
    const module = this.modules.get(name);
    if (!module) {
      return;
    }

    for (const type of Object.keys(module.events)) {
      if (this.handlerOwners.get(type) === name) {
        this.handlers.delete(type);
        this.handlerOwners.delete(type);
      }
    }
    this.moduleSettlers.delete(name);
    this.modules.delete(name);
  }

  async push(event: AgentStreamEvent<TOOLS>): Promise<void> {
    // 模块自己的 custom kind 优先：认领之后，这个 kind 不再落成不透明的
    // custom part；没人认领的 kind 仍然走核心的 `custom` handler。
    const key = event.type === "custom" ? `custom:${event.kind}` : event.type;
    const handler = this.handlers.get(key) ?? this.handlers.get(event.type);

    if (!handler) {
      this.warnUnhandled(event.type);
      return;
    }

    await handler(this.ctx, event);

    // 事件属于哪条 turn、哪个 step，就是哪个对象被改了，所以记账放在这里，
    // 而不是每个 handler 各记一次。唯一会多记的情况，是事件指向本装配器从未
    // 打开过的 part；此时写回的状态本来就一致，代价只是一次多余的写入，
    // 换来规则只存在于一处。
    const turnId = this.eventTurnId(event);
    this.markChanged(turnId);
    this.markChangedStep(turnId, this.eventStepId(event));
  }

  /**
   * 把流里没有收尾的东西收掉。
   *
   * `turn.finish` / `step.finish` / `*`.end 会把条目从待定表里删掉，所以表里
   * 留下的正好是从未结束的对象；把它们收掉就够了，对正常结束的流是空操作
   * ——那种情况下结束信息已经随 finish 事件到了。
   *
   * 只收尾仍为 `"streaming"` 的 turn 和 step。已经到 `done` 的保持原状：
   * 同一会话里更早的 turn，或在传输失败前就结束的 step，都属于这一类。
   * 存储层会持久化这些对象，把已完成的 step 改写成 aborted，会让 transcript
   * 声称做完的事从未发生。
   *
   * 结果由调用方给出：装配器无法从自己的状态区分传输失败和被取消，只知道
   * 没有任何东西结束。tool part 有自己的状态机，这里不动它。
   */
  settle(outcome: "aborted" | "error"): void {
    for (const turn of this.turnsMap.values()) {
      // 先取到局部变量再比较：直接比较 turn.status 会把属性窄化成
      // `"streaming"`，后面赋 outcome 就成了类型错误。
      const { status } = turn;
      if (status === "streaming") {
        // 断言回可写类型：上面的比较已经把 turn 收窄成 status: "streaming"。
        (turn as { status: string }).status = outcome;
      }
    }

    for (const step of this.stepsMap.values()) {
      const { status } = step;
      if (status === "streaming") {
        (step as { status: string }).status = outcome;
      }
    }

    // 模块自己的状态先收尾，它可能顺带用 `ctx.abandonPart` 撤掉 part；
    // 剩下的 part 再统一执行打开时登记的收尾动作。
    for (const settle of this.moduleSettlers.values()) {
      settle(outcome);
    }

    const open = [...this.openPartMap.values()];
    this.openPartMap.clear();
    for (const entry of open) {
      entry.onSettle();
    }
  }

  /**
   * 事件属于哪条 turn。
   *
   * 每个事件都用 `turnId` 指它。`abort` / `error` / `compaction.error` 也带
   * 一个，但不会改动它，所以返回 `undefined`。
   */
  private eventTurnId(event: AgentStreamEvent<TOOLS>): string | undefined {
    if (
      event.type === "abort" ||
      event.type === "error" ||
      event.type === "compaction.error"
    ) {
      return undefined;
    }

    return event.turnId;
  }

  /**
   * 事件改的是哪个 step。
   *
   * `turn.*` 只动 turn，`abort` / `error` 什么都不改，`compaction.error` 按
   * 压缩 id 撤回 part，所以它们都不指向 step。`turn.steer` 把整条 step 带在
   * 事件里，其余事件用 `stepId`。
   */
  private eventStepId(event: AgentStreamEvent<TOOLS>): string | undefined {
    if (
      event.type === "turn.start" ||
      event.type === "turn.finish" ||
      event.type === "abort" ||
      event.type === "error" ||
      event.type === "compaction.error"
    ) {
      return undefined;
    }

    if (event.type === "turn.steer") {
      return event.step.id;
    }

    return event.stepId;
  }

  /** 撤回 part：从 step 里移除，step 变空就一起删掉。 */
  private retractPart(turnId: string, stepId: string, partId: string): void {
    const step = this.stepsMap.get(stepId);
    if (step) {
      const content = step.content as AgentPart<TOOLS>[];
      const index = content.findIndex(
        (part) => "id" in part && part.id === partId
      );
      if (index !== -1) {
        content.splice(index, 1);
      }
    }

    this.dropStepIfEmpty(turnId, stepId);
  }

  /** 把 part 追加到 step；step 不存在时丢弃。 */
  private appendPart(stepId: string, part: AgentPart<TOOLS>): void {
    const step = this.stepsMap.get(stepId);
    if (step) {
      (step.content as AgentPart<TOOLS>[]).push(part);
    }
  }

  /**
   * 把没有内容的 step 从 turn 和索引里一起删掉。
   *
   * 压缩标记 step 只为承载它的 part 而存在；part 被撤回后留着空 step 会在
   * turn 里留下一个不标记任何东西的边界。
   */
  private dropStepIfEmpty(turnId: string, stepId: string): void {
    const step = this.stepsMap.get(stepId);
    if (!step || step.content.length > 0) {
      return;
    }

    this.stepsMap.delete(stepId);
    const turn = this.turnsMap.get(turnId);
    if (!turn) {
      return;
    }

    const steps = turn.content as AgentStep<TOOLS>[];
    const index = steps.findIndex((candidate) => candidate.id === stepId);
    if (index !== -1) {
      steps.splice(index, 1);
    }
  }

  /**
   * 记录一条 turn 被改动，只在第一次时记录。
   *
   * turn 是查出来的，不是从事件里拼出来的：流可能指向本装配器从未装载过的
   * turn，而不持有的 turn 也交不回去。
   */
  private markChanged(turnId: string | undefined): void {
    if (!turnId || this.changedTurnIds.has(turnId)) {
      return;
    }

    const turn = this.turnsMap.get(turnId);
    if (!turn) {
      return;
    }

    this.changedTurnIds.add(turnId);
    this.changedTurns.push(turn);
  }

  /**
   * 记录一个 step 被改动，只在第一次时记录。
   *
   * 和 `markChanged` 一样，只记本装配器真正持有的 step：事件指向没打开过的
   * step 时，写回它也不会命中任何行。
   */
  private markChangedStep(
    turnId: string | undefined,
    stepId: string | undefined
  ): void {
    if (
      !turnId ||
      !stepId ||
      this.changedStepIds.has(stepId) ||
      !this.stepsMap.has(stepId)
    ) {
      return;
    }

    this.changedStepIds.add(stepId);
    this.changedSteps.push({ turnId, stepId });
  }

  private warnUnhandled(type: string): void {
    if (this.warnedTypes.has(type)) {
      return;
    }

    this.warnedTypes.add(type);
    console.warn(`AgentTurnAssembler#push no handler for event ${type}`);
  }
}

/** 带 `\u0000` 的 key 拼不出歧义，因为 id 里不会有这个字符。 */
function partRefKey(ref: PartRef): string {
  return [ref.turnId, ref.stepId, ref.id].join("\u0000");
}

function toolPartKey(
  turnId: string,
  stepId: string,
  toolCallId: string
): string {
  return [turnId, stepId, toolCallId].join("\u0000");
}

/**
 * 内置模块；名字和注册顺序都只在这里出现。
 *
 * 返回类型写成 `AssemblerModule<TOOLS>[]` 不行：那会把每个模块的键抹成
 * `Partial<...>`，下面的完整性断言就读不到它们。所以数组保持字面量类型，
 * 由每个模块自己的 `satisfies` 保证形状。
 */
function coreAssemblers<TOOLS extends ToolSet>(): AssemblerModule<TOOLS>[] {
  const modules = [
    turnModule<TOOLS>(),
    stepModule<TOOLS>(),
    textModule<TOOLS>(),
    reasoningModule<TOOLS>(),
    customModule<TOOLS>(),
    sessionTitleModule<TOOLS>(),
    toolModule<TOOLS>(),
    compactionModule<TOOLS>(),
    lifecycleModule<TOOLS>(),
  ];

  // 加一个事件类型却没人处理时，Missing 不是 never，这一行编译失败。
  type Missing = Exclude<
    AgentEventType,
    CoveredEvents<(typeof modules)[number]>
  >;

  // 缺哪个事件，这里就要求哪个属性：报错信息直接点名事件类型。
  return modules satisfies AssemblerModule<TOOLS>[] & MissingHandlers<Missing>;
}

/** turn 的生命周期，以及回合运行中插入的引导消息。 */
function turnModule<TOOLS extends ToolSet>() {
  return {
    name: "turn",
    events: {
      "turn.start": (ctx, event) => {
        const existing = ctx.findTurn(event.turnId);
        if (existing) {
          existing.status = "streaming";
          return;
        }

        const turn = createTurn<TOOLS>(event);
        if (turn) {
          ctx.insertTurn(turn);
        }
      },

      "turn.finish": (ctx, event) => {
        const turn = ctx.findTurn(event.turnId);
        if (!turn) {
          return;
        }

        turn.status = event.status;
        // 第二个条件是把 turn 收窄成 error 分支；没有它取不到 `error` 字段。
        if (event.status === "error" && turn.status === "error") {
          turn.error = event.error;
        }
        if (event.status === "aborted" && turn.status === "aborted") {
          turn.abortReason = event.abortReason;
        }
        turn.usage = event.usage;
        turn.completedAt = event.createdAt;
      },

      "turn.steer": (ctx, event) => {
        const turn = ctx.findTurn(event.turnId);
        if (!turn || turn.type !== "assistant") {
          return;
        }

        // 重放时同一个 step 可能已经存在：覆盖内容，不重复追加。
        const existing = ctx.findStep(event.step.id);
        if (existing) {
          Object.assign(existing, event.step);
          return;
        }

        ctx.insertStep(event.turnId, event.step);
      },
    },
  } satisfies AssemblerModule<TOOLS>;
}

/** step 的生命周期。 */
function stepModule<TOOLS extends ToolSet>() {
  return {
    name: "step",
    events: {
      "step.start": (ctx, event) => {
        const existing = ctx.findStep(event.stepId);
        if (existing) {
          existing.status = "streaming";
          return;
        }

        const step = createStep<TOOLS>(event);
        if (step) {
          ctx.insertStep(event.turnId, step);
        }
      },

      "step.finish": (ctx, event) => {
        const step = ctx.findStep(event.stepId);
        if (!step) {
          return;
        }

        step.status = event.status;
        // 同 turn.finish：第二个条件用来收窄类型。
        if (event.status === "error" && step.status === "error") {
          step.error = event.error;
        }
        if (event.status === "aborted" && step.status === "aborted") {
          step.abortReason = event.abortReason;
        }
        step.usage = event.usage;
        step.metadata = event.metadata;
        step.finishReason = event.finishReason;
        step.rawFinishReason = event.rawFinishReason;
        step.providerMetadata = event.providerMetadata;
        step.completedAt = event.createdAt;
      },

      // 因审批而挂起的 step 在工具调用执行前就已经结束，耗时是后来才到的，
      // 所以只替换 performance：step 的状态、usage 和结束时间已经是对的。
      "step.metadata": (ctx, event) => {
        const step = ctx.findStep(event.stepId);
        if (step) {
          step.metadata = { ...step.metadata, ...event.metadata };
        }
      },
    },
  } satisfies AssemblerModule<TOOLS>;
}

/** 模型写出的文本。 */
function textModule<TOOLS extends ToolSet>() {
  return {
    name: "text",
    events: {
      "text.start": (ctx, event) => {
        const part: AgentTextPart = {
          type: "text",
          text: "",
          providerMetadata: event.providerMetadata,
          state: "streaming",
          createdAt: event.createdAt,
        };

        ctx.openPart(event, part, () => {
          // 这些 part 在这里收尾，而不是等自己的 `text.end`，所以没有事件
          // 时间可用：读时钟代替。
          part.state = "done";
          part.completedAt = Date.now();
        });
      },

      "text.delta": (ctx, event) => {
        const part = ctx.findOpenPart(event);
        if (!part || !isAgentTextPart(part)) {
          return;
        }

        part.text += event.text;
        part.completedAt = event.createdAt;
        part.providerMetadata = event.providerMetadata ?? part.providerMetadata;
      },

      "text.end": (ctx, event) => {
        const part = ctx.findOpenPart(event);
        if (!part || !isAgentTextPart(part)) {
          return;
        }

        part.state = "done";
        part.completedAt = event.createdAt;
        part.providerMetadata = event.providerMetadata ?? part.providerMetadata;
        ctx.closePart(event);
      },
    },
  } satisfies AssemblerModule<TOOLS>;
}

/** 模型的推理文本。 */
function reasoningModule<TOOLS extends ToolSet>() {
  return {
    name: "reasoning",
    events: {
      "reasoning.start": (ctx, event) => {
        const part: AgentReasoningPart = {
          type: "reasoning",
          text: "",
          providerMetadata: event.providerMetadata,
          state: "streaming",
          createdAt: event.createdAt,
        };

        ctx.openPart(event, part, () => {
          part.state = "done";
          part.completedAt = Date.now();
        });
      },

      "reasoning.delta": (ctx, event) => {
        const part = ctx.findOpenPart(event);
        if (!part || !isAgentReasoningPart(part)) {
          return;
        }

        part.text += event.text;
        part.completedAt = event.createdAt;
        part.providerMetadata = event.providerMetadata ?? part.providerMetadata;
      },

      "reasoning.end": (ctx, event) => {
        const part = ctx.findOpenPart(event);
        if (!part || !isAgentReasoningPart(part)) {
          return;
        }

        part.state = "done";
        part.completedAt = event.createdAt;
        part.providerMetadata = event.providerMetadata ?? part.providerMetadata;
        ctx.closePart(event);
      },
    },
  } satisfies AssemblerModule<TOOLS>;
}

/** provider 自带的、装配器不解释的内容。 */
function customModule<TOOLS extends ToolSet>() {
  return {
    name: "custom",
    events: {
      custom: (ctx, event) => {
        const part: AgentCustomContentPart = {
          type: "custom",
          kind: event.kind,
          providerMetadata: event.providerMetadata,
        };
        ctx.appendPart(event.stepId, part);
      },
    },
  } satisfies AssemblerModule<TOOLS>;
}

/** 会话标题。 */
function sessionTitleModule<TOOLS extends ToolSet>() {
  return {
    name: "session-title",
    events: {
      "session.title.start": (ctx, event) => {
        const part: AgentSessionTitlePart = {
          id: event.id,
          type: "session.title",
          state: "streaming",
        };

        ctx.openPart(event, part, () => {
          // 标题没有完成时间；中断时只把状态收掉，否则它会永远停在 streaming。
          part.state = "done";
        });
      },

      "session.title.end": (ctx, event) => {
        const part = ctx.findOpenPart(event);
        if (!part || !isAgentSessionTitlePart(part)) {
          return;
        }

        part.title = event.title;
        part.state = "done";
        ctx.closePart(event);
      },
    },
  } satisfies AssemblerModule<TOOLS>;
}

/** 工具调用的状态机。 */
function toolModule<TOOLS extends ToolSet>() {
  return {
    name: "tool",
    events: {
      "tool.input-start": (ctx, event) => {
        if (event.dynamic) {
          const part: AgentDynamicToolPart = {
            type: "dynamic-tool",
            state: "input-streaming",
            toolCallId: event.id,
            toolName: event.toolName,
            input: undefined,
            rawInput: "",
            providerExecuted: event.providerExecuted,
            callProviderMetadata: event.providerMetadata,
            title: event.title,
            toolMetadata: event.toolMetadata,
          };
          ctx.openToolPart(event.turnId, event.stepId, event.id, part);
          return;
        }

        const part: AgentStaticToolPart<TOOLS> = {
          type: `tool-${event.toolName}`,
          state: "input-streaming",
          toolCallId: event.id,
          input: undefined,
          rawInput: "",
          providerExecuted: event.providerExecuted,
          callProviderMetadata: event.providerMetadata,
          title: event.title,
          toolMetadata: event.toolMetadata,
        };
        ctx.openToolPart(event.turnId, event.stepId, event.id, part);
      },

      "tool.input-delta": async (ctx, event) => {
        const part = ctx.findToolPart(event.turnId, event.stepId, event.id);
        if (!part) {
          return;
        }

        part.rawInput += event.delta;
        const { value: partialArgs } = await parsePartialJson(part.rawInput);
        part.input = partialArgs;
        part.callProviderMetadata = event.providerMetadata;
      },

      "tool.input-end": (ctx, event) => {
        const part = ctx.findToolPart(event.turnId, event.stepId, event.id);
        if (!part) {
          return;
        }

        part.state = "input-available";
        part.callProviderMetadata = event.providerMetadata;
      },

      "tool.approval-request": (ctx, event) => {
        const part = ctx.findToolPart(event.turnId, event.stepId, event.id);
        if (!part) {
          return;
        }

        part.state = "approval-requested";
        part.approval = {
          id: event.approvalId,
          ...(event.approvalDescriptor
            ? { descriptor: event.approvalDescriptor }
            : {}),
          ...(Object.hasOwn(event, "inputSchemaInput")
            ? { inputSchemaInput: event.inputSchemaInput }
            : {}),
          ...(event.reason ? { requestReason: event.reason } : {}),
          ...(event.isAutomatic === true ? { isAutomatic: true } : {}),
          ...(event.signature ? { signature: event.signature } : {}),
          createdAt: event.createdAt,
        };
      },

      "tool.approval-response": (ctx, event) => {
        const part = ctx.findToolPart(event.turnId, event.stepId, event.id);
        if (!part) {
          console.warn(
            `AgentTurnAssembler#push no tool invocation for approval response ${event.approvalId}`
          );
          return;
        }

        part.state = "approval-responded";
        part.approval = {
          ...(part.approval ?? {
            id: event.approvalId,
            createdAt: event.createdAt,
          }),
          id: event.approvalId,
          approved: event.approved,
          approvedAt: event.createdAt,
          ...(event.reason ? { reason: event.reason } : {}),
          ...(event.data ? { data: event.data } : {}),
        };
        if (event.providerExecuted) {
          part.providerExecuted = event.providerExecuted;
        }
        if (event.providerMetadata) {
          part.callProviderMetadata = event.providerMetadata;
        }
      },

      "tool.call": (ctx, event) => {
        const part = ctx.findToolPart(
          event.turnId,
          event.stepId,
          event.toolCallId
        );
        if (!part) {
          return;
        }

        if (isAgentDynamicToolPart(part)) {
          if (event.invalid) {
            part.state = "output-error";
            part.errorText =
              (event.error as string | undefined) ?? "Invalid tool call";
          } else {
            part.state = "input-available";
          }
          part.input = event.input;
          part.title = event.title;
          part.toolCallId = event.toolCallId;
          part.toolMetadata = event.toolMetadata;
          part.toolName = event.toolName;
          part.providerExecuted = event.providerExecuted;
          part.callProviderMetadata = event.providerMetadata;
        } else if (isAgentStaticToolPart(part)) {
          if (event.invalid) {
            part.state = "output-error";
            part.errorText =
              (event.error as string | undefined) ?? "Invalid tool call";
          } else {
            part.state = "input-available";
          }
          part.input = event.input;
          part.title = event.title;
          part.toolCallId = event.toolCallId;
          part.toolMetadata = event.toolMetadata;
          part.providerExecuted = event.providerExecuted;
          part.callProviderMetadata = event.providerMetadata;
        }
      },

      "tool.result": (ctx, event) => {
        const part = ctx.findToolPart(
          event.turnId,
          event.stepId,
          event.toolCallId
        );
        if (!part) {
          return;
        }

        if (isAgentDynamicToolPart(part)) {
          part.state = "output-available";
          part.errorText = undefined;
          part.input = event.input;
          part.title = event.title;
          part.toolCallId = event.toolCallId;
          part.toolMetadata = event.toolMetadata;
          part.toolName = event.toolName;
          part.providerExecuted = event.providerExecuted;
          part.output = event.output;
          part.resultProviderMetadata = event.providerMetadata;
          part.preliminary = event.preliminary;
        } else if (isAgentStaticToolPart(part)) {
          part.state = "output-available";
          part.errorText = undefined;
          part.input = event.input;
          part.title = event.title;
          part.toolCallId = event.toolCallId;
          part.toolMetadata = event.toolMetadata;
          part.providerExecuted = event.providerExecuted;
          part.output = event.output;
          part.resultProviderMetadata = event.providerMetadata;
          part.preliminary = event.preliminary;
        }
      },

      "tool.output-denied": (ctx, event) => {
        const part = ctx.findToolPart(
          event.turnId,
          event.stepId,
          event.toolCallId
        );
        if (!part) {
          return;
        }

        if (isAgentDynamicToolPart(part)) {
          part.state = "output-denied";
          part.toolCallId = event.toolCallId;
          part.toolName = event.toolName;
          part.providerExecuted = event.providerExecuted;
        } else if (isAgentStaticToolPart(part)) {
          part.state = "output-denied";
          part.errorText = undefined;
          part.toolCallId = event.toolCallId;
          part.providerExecuted = event.providerExecuted;
        }
      },

      "tool.error": (ctx, event) => {
        const part = ctx.findToolPart(
          event.turnId,
          event.stepId,
          event.toolCallId
        );
        if (!part) {
          return;
        }

        if (isAgentDynamicToolPart(part)) {
          part.state = "output-error";
          part.errorText = event.error ? (event.error as string) : undefined;
          part.input = event.input;
          part.title = event.title;
          part.toolCallId = event.toolCallId;
          part.toolMetadata = event.toolMetadata;
          part.toolName = event.toolName;
          part.providerExecuted = event.providerExecuted;
          part.resultProviderMetadata = event.providerMetadata;
        } else if (isAgentStaticToolPart(part)) {
          part.state = "output-error";
          part.errorText = event.error ? (event.error as string) : undefined;
          part.input = event.input;
          part.title = event.title;
          part.toolCallId = event.toolCallId;
          part.toolMetadata = event.toolMetadata;
          part.providerExecuted = event.providerExecuted;
          part.resultProviderMetadata = event.providerMetadata;
        }
      },
    },
  } satisfies AssemblerModule<TOOLS>;
}

/** 压缩标记：开始即可见，失败不留痕迹。 */
function compactionModule<TOOLS extends ToolSet>() {
  return {
    name: "compaction",
    events: {
      "compaction.start": (ctx, event) => {
        const step = ctx.findStep(event.stepId);
        if (!step || step.type !== "compaction") {
          console.warn(
            `AgentTurnAssembler#push compaction.start without a compaction step ${event.id}`
          );
          return;
        }

        const part: AgentCompactionPart = {
          type: "compaction",
          id: event.id,
          state: "streaming",
          createdAt: event.createdAt,
        };
        ctx.openPart(event, part, () => {
          // 摘要没有到达，没有标记可留。移除这个 part 就把 turn 恢复到尝试
          // 之前的样子；step 只剩它时一起删掉。
          ctx.retractPart(event.turnId, event.stepId, part.id);
        });
      },

      "compaction.end": (ctx, event) => {
        const pending = ctx.findOpenPart(event);
        if (pending) {
          // 同 id 的 part 不是压缩标记：不覆盖它，也不另建一个。
          if (!isAgentCompactionPart(pending)) {
            return;
          }
          pending.state = "done";
          pending.completedAt = event.createdAt;
          pending.record = event.record;
          ctx.closePart(event);
          return;
        }

        // 没有 start 的 end 也要提交：记录才是目的，它指名的 step 足够承载。
        const step = ctx.findStep(event.stepId);
        if (!step || step.type !== "compaction") {
          console.warn(
            `AgentTurnAssembler#push compaction.end without a compaction step ${event.id}`
          );
          return;
        }
        step.content.push({
          type: "compaction",
          id: event.id,
          state: "done",
          createdAt: event.createdAt,
          record: event.record,
        });
      },

      "compaction.error": (ctx, event) => {
        // `compaction.error` 指名的是压缩，不是 step，所以按它自己的 id 找。
        ctx.abandonPart(event.id);
      },
    },
  } satisfies AssemblerModule<TOOLS>;
}

/** 不改变 transcript 的事件。 */
function lifecycleModule<TOOLS extends ToolSet>() {
  return {
    name: "lifecycle",
    events: {
      error: (_ctx, event) => {
        console.error("AgentTurnAssembler#push error", event.error);
      },
      abort: () => {
        // 不改变任何东西
      },
    },
  } satisfies AssemblerModule<TOOLS>;
}

function createTurn<TOOLS extends ToolSet>(
  event: TextStreamStartTurnEvent
): AgentTurn<TOOLS> | undefined {
  switch (event.turnType) {
    case "user": {
      const turn: AgentUserTurn = {
        type: "user",
        id: event.turnId,
        createdAt: event.createdAt,
        status: "streaming",
        content: [],
      };
      return turn;
    }
    case "assistant": {
      const turn: AgentAssistantTurn<TOOLS> = {
        type: "assistant",
        id: event.turnId,
        createdAt: event.createdAt,
        status: "streaming",
        content: [],
      };
      return turn;
    }
    case "compaction": {
      const turn: AgentCompactionTurn = {
        type: "compaction",
        id: event.turnId,
        createdAt: event.createdAt,
        status: "streaming",
        content: [],
      };
      return turn;
    }
    default: {
      console.error(
        `AgentTurnAssembler#startTurn unknown event ${JSON.stringify(event)}`
      );
      return undefined;
    }
  }
}

function createStep<TOOLS extends ToolSet>(
  event: TextStreamStartStepEvent
): AgentStep<TOOLS> | undefined {
  switch (event.stepType) {
    case "user": {
      const step: AgentUserStep = {
        type: "user",
        id: event.stepId,
        createdAt: event.createdAt,
        status: "streaming",
        content: [],
      };
      return step;
    }
    case "assistant": {
      const step: AgentAssistantStep<TOOLS> = {
        type: "assistant",
        id: event.stepId,
        createdAt: event.createdAt,
        status: "streaming",
        content: [],
        model: event.model,
      };
      return step;
    }
    case "compaction": {
      const step: AgentCompactionStep = {
        type: "compaction",
        id: event.stepId,
        createdAt: event.createdAt,
        status: "streaming",
        content: [],
        model: event.model,
      };
      return step;
    }
    case "session.title": {
      const step: AgentSessionTitleStep = {
        type: "session.title",
        id: event.stepId,
        createdAt: event.createdAt,
        status: "streaming",
        content: [],
        model: event.model,
      };
      return step;
    }
    case "steering": {
      // 引导 step 由 `turn.steer` 整体送达，不会从 step.start 开始。
      console.log(
        `AgentTurnAssembler#startStep unexpected steering event ${JSON.stringify(event)}`
      );
      return undefined;
    }
    default: {
      console.log(
        `AgentTurnAssembler#startStep unknown event ${JSON.stringify(event)}`
      );
      return undefined;
    }
  }
}
