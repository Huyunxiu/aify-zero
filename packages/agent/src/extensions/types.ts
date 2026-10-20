import type { Tool } from "ai";

import type { HookEventName, HookOptions, HooksMap } from "../hooks-manager";

export interface ExtensionAgentInfo {
  name: string;
  sessionId: string;
  workdir: string;
}

/**
 * 一段追加到系统提示里的内容。
 *
 * `render` 收到当前已经拼好的提示词，返回新的提示词；多个片段按
 * `priority`（数值小的先执行）和注册顺序依次套用。返回值是同步的：提示词
 * 必须在发起模型调用前就绪。
 */
export interface SystemPromptSection {
  /** 唯一 id，重复注册会抛错。 */
  id: string;
  /** 数值越小越先执行，默认 0。 */
  priority?: number;
  render(prompt: string): string;
}

/**
 * 扩展在 `init` 里能做的事情。
 *
 * 工具、hook 和提示片段立即生效。技能、上下文文件这类资源由扩展自己加载
 * 并保存在实例里，Agent 不需要知道它们的具体类型，只负责按顺序拼接
 * {@link SystemPromptSection}。
 */
export interface ExtensionAPI {
  readonly agent: Readonly<ExtensionAgentInfo>;

  tool(name: string, tool: Tool, options?: { override?: boolean }): void;

  systemPromptSection(section: SystemPromptSection): void;

  on<K extends HookEventName>(
    name: K,
    handler: HooksMap[K],
    options?: HookOptions
  ): void;
}

export interface ExtensionOptions {
  /** 唯一标识。重复注册会抛错，替换前先 dispose。 */
  id: string;
  name?: string;
  version?: string;
}

/**
 * 扩展基类。
 *
 * 子类在 `init` 里注册自己的贡献，并把加载到的资源保存在实例上；`dispose`
 * 只负责管理器管不到的外部资源（定时器、文件监听等），工具、hook 和提示
 * 片段会被管理器自动移除。
 */
export abstract class Extension {
  readonly id: string;
  readonly name?: string;
  readonly version?: string;

  constructor(options: ExtensionOptions) {
    this.id = options.id;
    this.name = options.name;
    this.version = options.version;
  }

  /** 注册期间调用；抛错时已经产生的贡献会被回滚。 */
  // oxlint-disable-next-line eslint/no-empty-function -- 默认不贡献任何东西
  init(_api: ExtensionAPI): void | Promise<void> {}

  /** 卸载时调用。 */
  // oxlint-disable-next-line eslint/no-empty-function -- 子类按需清理
  dispose(): void | Promise<void> {}
}
