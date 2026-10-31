import { arch, platform, release } from "node:os";

import type { ExtensionAPI, ExtensionOptions } from "./types";
import { Extension } from "./types";

/** 系统信息，宿主探测一次后写进提示词；测试可以直接覆盖。 */
export interface EnvironmentInfo {
  operatingSystem: string;
  architecture: string;
  shell: string;
  nodeVersion: string;
  /** `YYYY-MM-DD`，本地时区。 */
  date: string;
}

export interface EnvironmentExtensionOptions extends ExtensionOptions {
  /** 提示片段的位置，默认 -10（排在所有片段最前面）。 */
  sectionPriority?: number;
  /** 覆盖探测到的系统信息，主要给测试用。 */
  info?: Partial<EnvironmentInfo>;
  /** 覆盖当前时间，主要给测试用。 */
  now?: Date;
}

/** 用本地时区格式化成 `YYYY-MM-DD`，避免 `toISOString` 的 UTC 偏移。 */
function formatDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function detectEnvironment(now: Date): EnvironmentInfo {
  return {
    operatingSystem: `${platform()} ${release()}`,
    architecture: arch(),
    shell: process.env.SHELL ?? process.env.ComSpec ?? "unknown",
    nodeVersion: process.version,
    date: formatDate(now),
  };
}

/**
 * 渲染 Environment 段。
 *
 * 项目目录和会话目录是模型最需要知道的路径：项目目录的第一项是所有相对
 * 路径的基准，其余目录只能通过绝对路径访问；会话目录是它可以随便写临时
 * 文件、artifact 的地方。系统信息用来让模型选对命令（比如 shell 语法和
 * 平台差异）。
 */
export function renderEnvironment(
  projectDirs: readonly string[],
  sessionDir: string,
  info: EnvironmentInfo
): string {
  const [primary, ...additional] = projectDirs;
  if (!primary) {
    throw new Error(
      "renderEnvironment requires at least one project directory"
    );
  }

  // 单目录时用单数形式，避免提示词里出现一个只有一项的列表。
  const projectLines =
    additional.length === 0
      ? [`- Project directory: ${primary} (relative paths resolve here)`]
      : [
          "- Project directories:",
          `  - ${primary} (primary; relative paths resolve here)`,
          ...additional.map((dir) => `  - ${dir}`),
        ];

  return [
    "# Environment",
    "",
    ...projectLines,
    `- Session directory: ${sessionDir} (session-scoped scratch space for temporary files and artifacts)`,
    `- Operating system: ${info.operatingSystem}`,
    `- Architecture: ${info.architecture}`,
    `- Shell: ${info.shell}`,
    `- Node.js: ${info.nodeVersion}`,
    `- Current date: ${info.date}`,
  ].join("\n");
}

/**
 * 环境扩展：注册一段 Environment 提示，告诉模型它在哪个项目、哪个会话
 * 目录里工作，以及当前的系统环境。
 */
export class EnvironmentExtension extends Extension {
  readonly #sectionPriority: number;
  readonly #info: EnvironmentInfo;

  constructor(options: EnvironmentExtensionOptions) {
    super(options);
    this.#sectionPriority = options.sectionPriority ?? -10;
    this.#info = {
      ...detectEnvironment(options.now ?? new Date()),
      ...options.info,
    };
  }

  init(api: ExtensionAPI): void {
    const rendered = renderEnvironment(
      api.agent.projectDirs,
      api.agent.sessionDir,
      this.#info
    );

    api.instructionsSection({
      id: `${this.id}:environment`,
      priority: this.#sectionPriority,
      render: (prompt) => (prompt ? `${prompt}\n\n${rendered}` : rendered),
    });
  }
}
