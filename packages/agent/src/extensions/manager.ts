import type {
  AssemblerContext,
  AssemblerModule,
  AgentStreamEvent,
} from "@workspace/agent-client";
import { logger } from "@workspace/shared/logger";
import type { Tool, ToolSet } from "ai";

import type {
  HookEventName,
  HookOptions,
  HooksManager,
  HooksMap,
} from "../hooks-manager";
import type { AgentToolSet } from "../types";
import type {
  Extension,
  ExtensionAgentInfo,
  ExtensionAPI,
  SystemPromptSection,
} from "./types";

export interface ExtensionManagerDeps {
  agent: ExtensionAgentInfo;
  tools: ToolSet;
  registerTool(name: string, tool: Tool): void;
  unregisterTool(name: string): void;
  hooks: HooksManager;
}

interface RegisteredSection {
  section: SystemPromptSection;
  /** 同优先级时按注册顺序决定先后。 */
  order: number;
}

interface RegisteredExtension {
  extension: Extension;
  /** 这个扩展注册的工具，卸载时用它判断工具是否仍然归自己所有。 */
  tools: Map<string, Tool>;
  sections: RegisteredSection[];
  hookOffs: (() => void)[];
  /** 这个扩展贡献的装配模块，卸载时按顺序移除。 */
  assemblers: AssemblerModule<AgentToolSet>[];
}

/**
 * 扩展管理器。
 *
 * 工具、hook 和提示片段在 `add` 时立即生效；扩展自己的资源（技能、上下文
 * 文件等）由扩展在 `init` 里加载并持有，管理器不关心。
 */
export class ExtensionManager {
  readonly #extensions = new Map<string, RegisteredExtension>();
  readonly #sections: RegisteredSection[] = [];
  /** 按注册顺序排好的装配模块；每个 turn 开始时注入装配器。 */
  readonly #assemblers: AssemblerModule<AgentToolSet>[] = [];
  /** 已被认领的 custom kind → 扩展 id。 */
  readonly #assemblerKeys = new Map<string, string>();
  readonly #deps: ExtensionManagerDeps;
  #order = 0;

  constructor(deps: ExtensionManagerDeps) {
    this.#deps = deps;
  }

  /**
   * 注册一个扩展。重复 id、工具名或提示片段 id 冲突都会抛错；扩展的
   * `init` 失败时，已经产生的工具、hook 和提示片段会被回滚。
   */
  async add(extension: Extension): Promise<void> {
    if (this.#extensions.has(extension.id)) {
      throw new Error(`extension "${extension.id}" is already registered`);
    }

    const record: RegisteredExtension = {
      extension,
      tools: new Map(),
      sections: [],
      hookOffs: [],
      assemblers: [],
    };

    try {
      await extension.init(this.#createApi(record));
    } catch (error) {
      await this.#discard(record);
      throw error;
    }

    this.#extensions.set(extension.id, record);
  }

  /** 卸载一个扩展；不存在时返回 false。 */
  async dispose(id: string): Promise<boolean> {
    const record = this.#extensions.get(id);
    if (!record) {
      return false;
    }

    this.#extensions.delete(id);
    await this.#discard(record);

    return true;
  }

  /** 按注册的逆序卸载全部扩展。 */
  async disposeAll(): Promise<void> {
    const ids = [...this.#extensions.keys()].toReversed();
    for (const id of ids) {
      await this.dispose(id);
    }
  }

  /**
   * 当前所有装配模块，按注册顺序排好。
   *
   * 模块集合在 turn 开始时取一次快照：turn 中途加载或卸载扩展只影响下一个
   * turn，重放同一个 turn 才能得到同样的 transcript。
   */
  listAssemblers(): readonly AssemblerModule<AgentToolSet>[] {
    return [...this.#assemblers];
  }

  /** 当前所有提示片段，已经按执行顺序排好。 */
  listSections(): SystemPromptSection[] {
    return [...this.#sections]
      .toSorted(
        (a, b) =>
          (a.section.priority ?? 0) - (b.section.priority ?? 0) ||
          a.order - b.order
      )
      .map((entry) => entry.section);
  }

  /** 以 `base` 为起点，依次套用所有提示片段。 */
  renderSystemPrompt(base = ""): string {
    let prompt = base;
    for (const section of this.listSections()) {
      prompt = section.render(prompt);
    }
    return prompt;
  }

  #createApi(record: RegisteredExtension): ExtensionAPI {
    // 全部用箭头函数，让回调里的 this 仍然指向管理器。
    return {
      agent: this.#deps.agent,
      tool: (name, tool, options) => {
        if (name in this.#deps.tools && !options?.override) {
          throw new Error(`tool "${name}" is already registered`);
        }
        this.#deps.registerTool(name, tool);
        record.tools.set(name, tool);
      },
      systemPromptSection: (section) => {
        if (this.#sections.some((entry) => entry.section.id === section.id)) {
          throw new Error(
            `system prompt section "${section.id}" is already registered`
          );
        }

        const entry: RegisteredSection = { section, order: this.#order++ };
        record.sections.push(entry);
        this.#sections.push(entry);
      },
      on: <K extends HookEventName>(
        name: K,
        handler: HooksMap[K],
        options?: HookOptions
      ): void => {
        // 绑定在管理器上的 off 函数，卸载扩展时一并调用。
        record.hookOffs.push(this.#deps.hooks.on(name, handler, options));
      },
      assembler: (module) => {
        const name = `${record.extension.id}/${module.name}`;
        if (this.#assemblers.some((candidate) => candidate.name === name)) {
          throw new Error(`assembler "${name}" is already registered`);
        }

        for (const key of Object.keys(module.events)) {
          if (!key.startsWith(CUSTOM_EVENT_PREFIX)) {
            throw new Error(
              `assembler event "${key}" is not a custom kind; protocol events are assembled by the core modules`
            );
          }

          if (key.length === CUSTOM_EVENT_PREFIX.length) {
            throw new Error(`assembler event "${key}" has an empty kind`);
          }

          const owner = this.#assemblerKeys.get(key);
          if (owner) {
            throw new Error(
              `assembler event "${key}" is already handled by extension "${owner}"`
            );
          }
        }

        const isolated = isolateAssembler(record.extension.id, {
          ...module,
          name,
        });
        for (const key of Object.keys(module.events)) {
          this.#assemblerKeys.set(key, record.extension.id);
        }
        record.assemblers.push(isolated);
        this.#assemblers.push(isolated);
      },
    };
  }

  async #discard(record: RegisteredExtension): Promise<void> {
    for (const entry of record.sections) {
      this.#remove(this.#sections, entry);
    }

    for (const module of record.assemblers) {
      this.#remove(this.#assemblers, module);
      // 只撤自己还持有的键。
      for (const key of Object.keys(module.events)) {
        if (this.#assemblerKeys.get(key) === record.extension.id) {
          this.#assemblerKeys.delete(key);
        }
      }
    }

    for (const [name, tool] of record.tools) {
      // 只有当前工具仍然是这个扩展注册的那一个才删除，避免把后来覆盖的
      // 工具一起带走。
      if (this.#deps.tools[name] === tool) {
        this.#deps.unregisterTool(name);
      }
    }

    for (const off of record.hookOffs) {
      try {
        off();
      } catch (error) {
        logger.warn(
          `[extensions] "${record.extension.id}" hook cleanup failed`,
          error
        );
      }
    }

    try {
      await record.extension.dispose();
    } catch (error) {
      logger.warn(
        `[extensions] "${record.extension.id}" dispose failed`,
        error
      );
    }
  }

  #remove<T>(list: T[], entry: T): void {
    const index = list.indexOf(entry);
    if (index !== -1) {
      list.splice(index, 1);
    }
  }
}

/** 扩展自己的事件键前缀。 */
const CUSTOM_EVENT_PREFIX = "custom:";

/**
 * 把扩展的 handler 包成失败不打断流的形式。
 *
 * 扩展是运行期加载的代码：一个 handler 抛错时，装配器继续装配剩下的 part，
 * 而不是让整轮对话失败。错误带扩展 id，日志里能定位到来源。
 */
function isolateAssembler(
  extensionId: string,
  module: AssemblerModule<AgentToolSet>
): AssemblerModule<AgentToolSet> {
  const events: Record<string, unknown> = {};

  for (const [key, handler] of Object.entries(module.events)) {
    if (typeof handler !== "function") {
      continue;
    }

    const run = handler as (
      ctx: AssemblerContext<AgentToolSet>,
      event: AgentStreamEvent<AgentToolSet>
    ) => void | Promise<void>;

    events[key] = async (
      ctx: AssemblerContext<AgentToolSet>,
      event: AgentStreamEvent<AgentToolSet>
    ): Promise<void> => {
      try {
        await run(ctx, event);
      } catch (error) {
        logger.warn(
          `[extensions] "${extensionId}" assembler failed on ${event.type}`,
          error
        );
      }
    };
  }

  return {
    name: module.name,
    events: events as unknown as AssemblerModule<AgentToolSet>["events"],
    ...(module.settle ? { settle: module.settle } : {}),
  };
}
