import { renderProjectContext } from "../context-files";
import type { ContextFile } from "../context-files";
import { loadContextFiles, loadSkills } from "../resources";
import type { ContextSource, SkillSource } from "../resources/types";
import { SKILL_DIRS, SkillManager } from "../skill/skill-manager";
import type {
  ExtensionAPI,
  ExtensionAgentInfo,
  ExtensionOptions,
} from "./types";
import { Extension } from "./types";

/** 资源只从主目录加载，即 `projectDirs` 的第一项。 */
function primaryProjectDir(agent: Readonly<ExtensionAgentInfo>): string {
  const [projectDir] = agent.projectDirs;
  if (!projectDir) {
    throw new Error("extension requires at least one project directory");
  }
  return projectDir;
}

export interface SkillExtensionOptions extends ExtensionOptions {
  sources: readonly SkillSource[];
  /** 技能排序用的目录顺序，默认 {@link SKILL_DIRS}。 */
  dirs?: readonly string[];
  /** 提示片段的位置，默认 10（排在项目说明之后）。 */
  sectionPriority?: number;
}

/**
 * 技能扩展：加载 `sources` 里的技能，持有 `SkillManager`，并注册一段
 * 「Available Skills」提示。
 *
 * 加载发生在 `init`，所以注册完成时 `manager` 已经可用。
 */
export class SkillExtension extends Extension {
  readonly #sources: readonly SkillSource[];
  readonly #dirs: readonly string[];
  readonly #sectionPriority: number;
  #manager?: SkillManager;

  constructor(options: SkillExtensionOptions) {
    super(options);
    this.#sources = options.sources;
    this.#dirs = options.dirs ?? SKILL_DIRS;
    this.#sectionPriority = options.sectionPriority ?? 10;
  }

  /**
   * 这个扩展加载到的技能。`load-skill` 工具需要按名字查技能，所以由宿主
   * 在注册后取走；系统提示里的技能列表仍由扩展注册的片段生成。
   */
  get manager(): SkillManager {
    if (!this.#manager) {
      throw new Error(`skill extension "${this.id}" is not initialized`);
    }
    return this.#manager;
  }

  async init(api: ExtensionAPI): Promise<void> {
    const skills = await loadSkills(this.#sources, {
      projectDir: primaryProjectDir(api.agent),
    });
    const manager = SkillManager.fromSkills(skills, { dirs: this.#dirs });
    this.#manager = manager;

    api.systemPromptSection({
      id: `${this.id}:skills`,
      priority: this.#sectionPriority,
      render: (prompt) => manager.appendPrompt(prompt),
    });
  }
}

export interface ContextExtensionOptions extends ExtensionOptions {
  sources: readonly ContextSource[];
  /** 提示片段的位置，默认 0（排在环境信息之后）。 */
  sectionPriority?: number;
}

/**
 * 上下文扩展：加载 `sources` 里的 AGENTS.md / CLAUDE.md，并注册一段项目
 * 说明提示。文件按 `path` 合并，合并规则由 {@link loadContextFiles} 负责。
 */
export class ContextExtension extends Extension {
  readonly #sources: readonly ContextSource[];
  readonly #sectionPriority: number;

  constructor(options: ContextExtensionOptions) {
    super(options);
    this.#sources = options.sources;
    this.#sectionPriority = options.sectionPriority ?? 0;
  }

  async init(api: ExtensionAPI): Promise<void> {
    const files: ContextFile[] = await loadContextFiles(this.#sources, {
      projectDir: primaryProjectDir(api.agent),
    });
    const rendered = renderProjectContext(files);
    if (!rendered) {
      return;
    }

    api.systemPromptSection({
      id: `${this.id}:context`,
      priority: this.#sectionPriority,
      render: (prompt) => (prompt ? `${prompt}\n\n${rendered}` : rendered),
    });
  }
}
