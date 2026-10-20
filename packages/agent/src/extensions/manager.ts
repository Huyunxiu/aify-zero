import { logger } from "@workspace/shared/logger";
import type { Tool, ToolSet } from "ai";

import type {
  HookEventName,
  HookOptions,
  HooksManager,
  HooksMap,
} from "../hooks-manager";
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
    };
  }

  async #discard(record: RegisteredExtension): Promise<void> {
    for (const entry of record.sections) {
      this.#remove(this.#sections, entry);
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
