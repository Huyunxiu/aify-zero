import type { ExtensionAPI, ExtensionOptions } from "./types";
import { Extension } from "./types";

export interface ApprovalExtensionOptions extends ExtensionOptions {
  /** 调用前必须由用户确认的工具名。 */
  tools: readonly string[];
}

/**
 * 审批策略扩展：把指定工具的调用交给用户确认。
 *
 * 哪些工具需要问是产品决定，不是内核知识。内核只保存名单并按名字询问；这份
 * 名单由扩展声明，子 agent 从父继承，不再由核心按工具名硬编码。
 */
export class ApprovalExtension extends Extension {
  readonly #tools: ReadonlySet<string>;

  constructor(options: ApprovalExtensionOptions) {
    super(options);
    this.#tools = new Set(options.tools);
  }

  init(api: ExtensionAPI): void {
    for (const name of this.#tools) {
      api.approvalRequired(name);
    }
  }
}
