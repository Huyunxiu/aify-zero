import { DevToolsTelemetry } from "@ai-sdk/devtools";
import type { ModelEffort } from "@workspace/shared/constants";
import { registerTelemetry } from "ai";
import type { Tool, ToolSet } from "ai";

import type { AgentContext } from "./agent-context";
import type { AgentSession } from "./agent-session";
import { Capabilities } from "./extensions/capabilities";
import type {
  EventWriter,
  SubagentFactory,
  ToolEnvironment,
  TranscriptReader,
} from "./extensions/capabilities";
import { ExtensionManager } from "./extensions/manager";
import type { Extension } from "./extensions/types";
import type { HookContext } from "./hooks-manager";
import { HooksManager } from "./hooks-manager";
import { AgentInbox } from "./inbox/agent-inbox";
import { CompactionController } from "./kernel/compaction-controller";
import type { ModelGateway } from "./kernel/model-gateway";
import { RunController } from "./kernel/run-controller";
import type { AgentStreamOptions, AgentStreamSignal } from "./kernel/run-types";
import { StepRunner } from "./kernel/step-runner";
import { TranscriptJournal } from "./kernel/transcript-journal";
import { TurnRunner } from "./kernel/turn-runner";
import { createOpenAICompatibleGateway } from "./model/gateway";
import type { AgentStore } from "./storage";
import { evaluateToolApproval } from "./tool-approval";
import type { ToolApprovalPattern } from "./tool-approval";
import type { CallTargetResolver } from "./tools/execution";
import type { ToolExposure } from "./types";

export type { AgentStreamOptions, AgentStreamSignal } from "./kernel/run-types";
export { NothingToCompactError } from "./kernel/run-types";
export type { AgentStepResult, StepOutcome } from "./kernel/step-runner";

registerTelemetry(DevToolsTelemetry());

export type AgentOptions = {
  name: string;
  sessionId: string;
  session: AgentSession;
  tools?: ToolSet;
  /**
   * 工具名到暴露方式的表；缺省表示每个工具都是 `direct`。
   *
   * 子 agent 从这里继承父的暴露方式，否则父里藏起来的 MCP 工具会在子会话
   * 里重新变成常驻工具。
   */
  toolExposure?: ReadonlyMap<string, ToolExposure>;
  /** 工具名到转调解析函数；子 agent 从父继承。 */
  toolRoute?: ReadonlyMap<string, CallTargetResolver>;
  store: AgentStore;
  instructions?: string;
  context: AgentContext;
  hooks?: HooksManager;
  extensionApi?: HookContext;
  apiKey: string;
  apiUrl: string;
  providerId: string;
  modelId: string;
  modelEffort?: ModelEffort;
  /**
   * 这个 agent 所属的外部 abort scope，由派生它的父传进来。父停时它跟着停；和它
   * 自己的 `abort()` 是并集而不是替代，所以子 agent 仍然能被单独停掉。
   */
  abortSignal?: AbortSignal;
  /**
   * 会话待发送消息的入口。默认用同一个 store 构造；测试可以注入替身。
   */
  inbox?: AgentInbox;
  /**
   * 由组合根注入的子会话工厂。
   *
   * 子 agent 不允许再派生，所以它不传这个选项；没有工厂时 `subagents`
   * capability 也不存在，`task` 扩展会在 `use` 时直接报错。
   */
  subagentFactory?: (agent: Agent) => SubagentFactory;
  /**
   * 覆盖模型网关。默认按 `apiKey` / `apiUrl` / `providerId` 构造 OpenAI 兼容
   * 适配器；测试在这里注入替身。
   */
  gateway?: ModelGateway;
};

export class Agent {
  name: string;
  sessionId: string;
  instructions?: string;
  tools: ToolSet;
  /** 工具名到暴露方式，和 `tools` 同生共死：注册写入，注销删除。 */
  toolExposure: Map<string, ToolExposure>;
  /**
   * 工具名到转调解析函数。
   *
   * 它是一个工具自己的性质，所以跟着工具集走：子会话复制工具集时，转调入口
   * 才不会变成一个只会报错的空壳。
   */
  toolRoute: Map<string, CallTargetResolver>;

  store: AgentStore;
  readonly inbox: AgentInbox;
  hooks: HooksManager;
  extensionApi: HookContext;

  apiKey: string;
  apiUrl: string;
  providerId: string;
  /** 模型调用的端口；具体协议由适配器决定。 */
  readonly gateway: ModelGateway;

  context: AgentContext;
  session: AgentSession;

  readonly #abortController = new AbortController();
  /**
   * 扩展管理器。工具、hook 和系统提示片段在注册时立即生效；扩展自己的
   * 资源由扩展持有，Agent 不关心。
   */
  readonly extensions: ExtensionManager;
  /** turn / step 的落库记账。 */
  readonly #journal: TranscriptJournal;
  /** 单步模型调用与工具执行。 */
  readonly #stepRunner: StepRunner;
  /** turn 内部循环、压缩与 steering。 */
  readonly #turnRunner: TurnRunner;
  /** 一次运行的生命周期：流、锁、onFinish。 */
  readonly #runController: RunController;
  /** 按调用入参决定 deny / ask / allow 的函数；子 agent 继承。 */
  #toolApprovalPattern: ToolApprovalPattern | undefined;
  /** 压缩策略与摘要器。 */
  readonly #compaction: CompactionController;

  constructor(options: AgentOptions) {
    this.name = options.name;
    this.sessionId = options.sessionId;
    this.instructions = options.instructions;
    this.tools = options.tools ?? {};
    this.toolExposure = new Map(options.toolExposure);
    this.toolRoute = new Map(options.toolRoute);
    this.store = options.store;
    this.inbox = options.inbox ?? new AgentInbox(options.store);
    this.hooks = options.hooks ?? new HooksManager();
    this.extensionApi = options.extensionApi ?? {};
    this.apiKey = options.apiKey;
    this.apiUrl = options.apiUrl;
    this.providerId = options.providerId;

    this.context = options.context;
    this.context.modelId = options.modelId;
    this.context.modelEffort = options.modelEffort;
    // 这一轮的 abort scope 属于跑它的 agent：`abort()` 是入口，每一步都从 context
    // 上把 signal 读回去。子 agent 由父把自己的 signal 传进来，两者取并集——父一停
    // 它就跟着停，而它自己的 `abort()` 仍然独立生效。
    this.context.abortSignal = options.abortSignal
      ? AbortSignal.any([options.abortSignal, this.#abortController.signal])
      : this.#abortController.signal;
    this.session = options.session;
    // 扩展只拿到工具需要的环境，拿不到完整的 context。路径在会话内不变，
    // 所以在构造时取一次快照。
    const environment: ToolEnvironment = {
      sessionId: this.sessionId,
      projectDirs: this.context.projectDirs,
      primaryProjectDir: this.context.primaryProjectDir,
      sessionDir: this.context.sessionDir,
      ...(this.context.projectId === undefined
        ? {}
        : { projectId: this.context.projectId }),
      ...(this.context.jobs === undefined ? {} : { jobs: this.context.jobs }),
    };

    this.gateway =
      options.gateway ??
      createOpenAICompatibleGateway({
        apiKey: this.apiKey,
        baseURL: this.apiUrl,
        name: this.providerId,
      });

    this.#journal = new TranscriptJournal({
      store: this.store,
      session: this.session,
      sessionId: this.sessionId,
      streamId: () => this.#runController.streamId,
    });

    // transcript 是内核自己的状态；子会话工厂由组合根注入，子 agent 不传。
    const transcript: TranscriptReader = { turns: () => this.session.turns };
    // 后台任务可能在流关闭后才写事件，那时没有读者，写入被丢弃。
    const events: EventWriter = {
      write: async (event) => {
        await this.context.controller?.write(event);
      },
    };
    const capabilities = new Map<string, unknown>([
      [Capabilities.transcript.id, transcript],
      [Capabilities.model.id, this.gateway],
      [Capabilities.store.id, this.store],
      [Capabilities.events.id, events],
      [Capabilities.hooks.id, this.hooks],
      [Capabilities.abortSignal.id, () => this.context.abortSignal],
    ]);

    if (options.subagentFactory) {
      capabilities.set(
        Capabilities.subagents.id,
        options.subagentFactory(this)
      );
    }

    this.extensions = new ExtensionManager({
      agent: {
        name: this.name,
        sessionId: this.sessionId,
        projectDirs: this.context.projectDirs,
        sessionDir: this.context.sessionDir,
      },
      environment,
      capabilities,
      tools: this.tools,
      registerTool: (name, tool, exposure, resolveCall) => {
        this.registerTool(name, tool, exposure, resolveCall);
      },
      unregisterTool: (name) => {
        this.unregisterTool(name);
      },
      hooks: this.hooks,
    });

    this.#compaction = new CompactionController({
      store: this.store,
      session: this.session,
      context: this.context,
      hooks: this.hooks,
      extensionApi: this.extensionApi,
      strategy: () => this.extensions.capability(Capabilities.compaction),
      journal: this.#journal,
      instructions: () => this.#runController.instructions(),
    });

    this.#stepRunner = new StepRunner({
      gateway: this.gateway,
      tools: this.tools,
      toolExposure: this.toolExposure,
      session: this.session,
      context: this.context,
      hooks: this.hooks,
      extensionApi: this.extensionApi,
      sessionId: this.sessionId,
      journal: this.#journal,
      runtimeSettings: () => this.#runController.runtimeSettings(),
      decideToolApproval: (request) =>
        evaluateToolApproval(this.#toolApprovalPattern, request),
      handleOverflow: (error, turnId) =>
        this.#compaction.handleOverflow(error, turnId),
      resolveCallTarget: (toolCall) =>
        this.toolRoute.get(toolCall.toolName)?.(toolCall),
    });

    this.#turnRunner = new TurnRunner({
      session: this.session,
      context: this.context,
      inbox: this.inbox,
      sessionId: this.sessionId,
      stepRunner: this.#stepRunner,
      compaction: this.#compaction,
      journal: this.#journal,
      hooks: this.hooks,
      extensionApi: this.extensionApi,
      streamId: () => this.#runController.streamId,
    });

    this.#runController = new RunController({
      name: this.name,
      sessionId: this.sessionId,
      session: this.session,
      context: this.context,
      store: this.store,
      hooks: this.hooks,
      extensionApi: this.extensionApi,
      extensions: this.extensions,
      turnRunner: this.#turnRunner,
      compaction: this.#compaction,
      journal: this.#journal,
      baseInstructions: () => this.instructions,
    });
  }

  registerTool(
    name: string,
    tool: Tool,
    exposure: ToolExposure = "direct",
    resolveCall?: CallTargetResolver
  ) {
    this.tools[name] = tool;
    this.toolExposure.set(name, exposure);
    if (resolveCall) {
      this.toolRoute.set(name, resolveCall);
    } else {
      this.toolRoute.delete(name);
    }
  }

  unregisterTool(name: string) {
    // oxlint-disable-next-line typescript/no-dynamic-delete
    delete this.tools[name];
    this.toolExposure.delete(name);
    this.toolRoute.delete(name);
  }

  /**
   * 注册工具审批函数：按调用入参决定 deny / ask / allow。
   *
   * 重复注册会替换前一个函数。它和扩展的 `pre_tool_call` 决策一起折叠，
   * deny 最优先；返回的函数把注册撤掉。
   */
  registerToolApprovalPattern(pattern: ToolApprovalPattern): () => void {
    this.#toolApprovalPattern = pattern;

    return () => {
      if (this.#toolApprovalPattern === pattern) {
        this.#toolApprovalPattern = undefined;
      }
    };
  }

  /**
   * 注册一个扩展。工具、hook 和系统提示片段在 `init` 期间立即生效；扩展
   * 自己加载的资源保存在扩展实例上。
   */
  async registerExtension(extension: Extension): Promise<void> {
    await this.extensions.add(extension);
    this.#syncPromptSections();
  }

  /** 卸载一个扩展；返回它是否存在。 */
  async disposeExtension(id: string): Promise<boolean> {
    const disposed = await this.extensions.dispose(id);
    this.#syncPromptSections();
    return disposed;
  }

  /** 按注册的逆序卸载全部扩展。 */
  async dispose(): Promise<void> {
    await this.extensions.disposeAll();
    this.#syncPromptSections();
  }

  /**
   * 把当前的提示片段快照写进上下文，子 agent 派生时从这里继承。主 agent
   * 自己每次 `stream()` 都从管理器重新拼接，所以这里只是为了让子 agent
   * 拿到和父一致的片段。
   */
  #syncPromptSections(): void {
    this.context.instructionsSections = this.extensions.listSections();
  }

  /**
   * Stops the turn this agent is running: the model call in flight, the tool
   * calls it has open, and the step loop all watch this signal. The turn still
   * finishes — with `status: "aborted"` — so the reader sees an ending.
   */
  abort(): void {
    this.#abortController.abort();
  }

  /**
   * 正在运行的流类型；空闲或结束时为 undefined。
   *
   * 服务端用它判断 steering 是否可用：只有普通回合还有下一步可以接收引导
   * 消息，手工压缩没有。
   */
  get streamKind(): AgentStreamSignal["type"] | undefined {
    return this.#runController.streamKind;
  }

  /**
   * 当前的工具审批函数。
   *
   * 子 agent 派生时从这里继承：它不重新注册扩展，但工具集和审批函数要跟
   * 父保持一致。
   */
  get toolApprovalPattern(): ToolApprovalPattern | undefined {
    return this.#toolApprovalPattern;
  }

  async stream(options: AgentStreamOptions) {
    return await this.#runController.stream(options);
  }
}
