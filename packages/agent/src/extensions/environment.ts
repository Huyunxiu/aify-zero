import { arch, platform, release } from "node:os";

import type { SandboxDescription } from "@workspace/sandbox";

import type { ExtensionAPI, ExtensionOptions } from "./types";
import { Extension } from "./types";

/**
 * What the host detects once about the machine. Tests can override it.
 *
 * The date is not here: it changes on its own, so the renderer reads it.
 */
export interface EnvironmentInfo {
  operatingSystem: string;
  architecture: string;
  nodeVersion: string;
}

export interface EnvironmentExtensionOptions extends ExtensionOptions {
  /** Where the environment block runs. Defaults to -10, ahead of every other block. */
  sectionPriority?: number;
  /** Overrides the detected machine facts. Tests use it. */
  info?: Partial<EnvironmentInfo>;
  /** The clock the date is read from at render time. Tests move it. */
  clock?: () => Date;
}

/** Formats a local date as `YYYY-MM-DD`, so the UTC offset cannot shift the day. */
function formatDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Reads what does not change while the process runs. */
function detectEnvironment(): EnvironmentInfo {
  return {
    operatingSystem: `${platform()} ${release()}`,
    architecture: arch(),
    nodeVersion: process.version,
  };
}

/**
 * Renders the environment block.
 *
 * The project directories are the paths the model needs first: the first one is
 * the base for every relative path, and the rest are reachable by absolute path.
 * The machine facts let it choose the right commands for the platform.
 *
 * The paths come from the sandbox describing itself, never from the host, so a
 * different adapter shows the model the paths that exist in that environment.
 *
 * The session directory is not a project directory: it has its own block, so this
 * function only excludes it from the roots.
 */
export interface EnvironmentRenderOptions {
  readonly botWorkspaceDir?: string;
  readonly projectDirs?: readonly string[];
}

function renderWorkspaceLines(
  primary: string,
  candidateRoots: readonly string[],
  sessionDir: string,
  botWorkspaceDir?: string
): string[] {
  if (botWorkspaceDir === undefined) {
    const additional = candidateRoots.filter(
      (dir) => dir !== primary && dir !== sessionDir
    );
    // A single directory reads as one line, not as a list with one entry.
    return additional.length === 0
      ? [`- Project directory: ${primary} (relative paths resolve here)`]
      : [
          "- Project directories:",
          `  - ${primary} (primary; relative paths resolve here)`,
          ...additional.map((dir) => `  - ${dir}`),
        ];
  }

  if (primary === botWorkspaceDir) {
    const extraProjects = candidateRoots.filter(
      (dir) => dir !== primary && dir !== sessionDir && dir !== botWorkspaceDir
    );
    return [
      `- Bot workspace directory: ${botWorkspaceDir} (relative paths resolve here)`,
      ...(extraProjects.length === 0
        ? []
        : [
            "- Additional project directories:",
            ...extraProjects.map((dir) => `  - ${dir}`),
          ]),
    ];
  }

  const additional = candidateRoots.filter(
    (dir) => dir !== primary && dir !== sessionDir && dir !== botWorkspaceDir
  );
  const projectLines =
    additional.length === 0
      ? [`- Project directory: ${primary} (relative paths resolve here)`]
      : [
          "- Project directories:",
          `  - ${primary} (primary; relative paths resolve here)`,
          ...additional.map((dir) => `  - ${dir}`),
        ];

  return [
    ...projectLines,
    `- Bot workspace directory: ${botWorkspaceDir} (persistent workspace for this Bot)`,
  ];
}

export function renderEnvironment(
  description: SandboxDescription,
  sessionDir: string,
  info: EnvironmentInfo,
  options: EnvironmentRenderOptions = {}
): string {
  const primary = description.cwd;
  const candidateRoots = options.projectDirs ?? description.roots;
  const workspaceLines = renderWorkspaceLines(
    primary,
    candidateRoots,
    sessionDir,
    options.botWorkspaceDir
  );

  return [
    "## Environment",
    "",
    ...workspaceLines,
    // Only a sandbox that states a limit renders this line: a local run has no
    // boundary worth telling the model about up front.
    ...(description.note === undefined
      ? []
      : [`- Sandbox: ${description.note}`]),
    `- Operating system: ${info.operatingSystem}`,
    `- Architecture: ${info.architecture}`,
    `- Node.js: ${info.nodeVersion}`,
  ].join("\n");
}

/** The heading of the block that changes on its own. */
export const SESSION_HEADING = "## This session";

/**
 * The block that changes while nothing else does.
 *
 * It carries the session directory, which is new for every session, and the date,
 * which is new every day. It runs last so that either change rewrites only this
 * block: everything before it is the prefix a provider has already cached.
 */
export function renderSessionSection(sessionDir: string, date: Date): string {
  return [
    SESSION_HEADING,
    "",
    `- Session directory: ${sessionDir} (session-scoped scratch space for temporary files and artifacts)`,
    `- Current date: ${formatDate(date)}`,
  ].join("\n");
}

/**
 * Runs after every built-in block: the subagent catalogue is 90.
 *
 * A host block registered above 100 follows this one, and so does the environment
 * block when a host raises its own priority past 100. Either way the prefix is
 * stable only up to that block, which is the host's choice to make.
 */
const SESSION_SECTION_PRIORITY = 100;

/**
 * The environment extension: two blocks.
 *
 * `Environment` describes the project and the machine, and stays the same for as
 * long as the host does. `This session` carries the session directory and the
 * date, the two values that move on their own, so it goes last.
 */
export class EnvironmentExtension extends Extension {
  readonly #sectionPriority: number;
  readonly #info: EnvironmentInfo;
  readonly #clock: () => Date;

  constructor(options: EnvironmentExtensionOptions) {
    super(options);
    this.#sectionPriority = options.sectionPriority ?? -10;
    this.#info = { ...detectEnvironment(), ...options.info };
    this.#clock = options.clock ?? (() => new Date());
  }

  init(api: ExtensionAPI): void {
    const { sessionDir } = api.agent;
    const rendered = renderEnvironment(
      api.environment.sandbox.describe(),
      sessionDir,
      this.#info,
      {
        botWorkspaceDir: api.environment.botWorkspaceDir,
        projectDirs: api.agent.projectDirs,
      }
    );

    api.instructionsSection({
      id: `${this.id}:environment`,
      priority: this.#sectionPriority,
      render: () => rendered,
    });

    api.instructionsSection({
      id: `${this.id}:session`,
      priority: SESSION_SECTION_PRIORITY,
      render: () => renderSessionSection(sessionDir, this.#clock()),
    });
  }
}
