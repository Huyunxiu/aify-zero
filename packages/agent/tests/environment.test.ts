import type { ToolSet } from "ai";
import { describe, expect, test } from "vitest";

import {
  EnvironmentExtension,
  renderEnvironment,
  SESSION_HEADING,
} from "../src/extensions/environment.js";
import { ExtensionManager } from "../src/extensions/manager.js";
import type { ExtensionAPI } from "../src/extensions/types.js";
import { Extension } from "../src/extensions/types.js";
import { HooksManager } from "../src/hooks-manager.js";
import { testSandbox } from "./helpers/sandbox.js";

/** Everything the prompt says before the block that changes on its own. */
const beforeSession = (prompt: string): string => {
  const index = prompt.indexOf(SESSION_HEADING);
  if (index === -1) {
    throw new Error("the session block is missing from the prompt");
  }
  return prompt.slice(0, index);
};

/** A clock that stays put, for a test that does not care about the time. */
const fixedClock = (): Date => new Date(2026, 9, 21);

const projectDir = "/repo";
const sessionDir = "/home/user/.aify-zero/sessions/session-1";

const makeManager = (dir: string = sessionDir): ExtensionManager => {
  const tools: ToolSet = {};

  return new ExtensionManager({
    agent: {
      name: "main",
      sessionId: "session-1",
      projectDirs: [projectDir],
      sessionDir: dir,
    },
    environment: {
      sessionId: "session-1",
      projectDirs: [projectDir],
      primaryProjectDir: projectDir,
      sessionDir: dir,
      sandbox: testSandbox(projectDir, dir),
    },
    tools,
    registerTool: (name, tool) => {
      tools[name] = tool;
    },
    unregisterTool: (name) => {
      Reflect.deleteProperty(tools, name);
    },
    hooks: new HooksManager(),
  });
};

/** 注册一段固定文本的提示片段，用来验证片段顺序。 */
class SectionExtension extends Extension {
  readonly #priority: number;
  readonly #text: string;

  constructor(id: string, priority: number, text: string) {
    super({ id });
    this.#priority = priority;
    this.#text = text;
  }

  init(api: ExtensionAPI): void {
    api.instructionsSection({
      id: `${this.id}:section`,
      priority: this.#priority,
      render: () => this.#text,
    });
  }
}

describe(EnvironmentExtension, () => {
  test("renders the project directory and the detected system info", async () => {
    const manager = makeManager();

    await manager.add(
      new EnvironmentExtension({
        id: "environment",
        // 10 月是 9，验证本地日期格式化成 YYYY-MM-DD。
        clock: () => new Date(2026, 9, 21),
        info: {
          operatingSystem: "linux 6.8",
          architecture: "x64",
          shell: "/bin/zsh",
          nodeVersion: "v22.0.0",
        },
      })
    );

    expect(manager.renderInstructions("base")).toBe(
      [
        "base",
        "",
        "## Environment",
        "",
        `- Project directory: ${projectDir} (relative paths resolve here)`,
        "- Operating system: linux 6.8",
        "- Architecture: x64",
        "- Shell: /bin/zsh",
        "- Node.js: v22.0.0",
        "",
        "## This session",
        "",
        `- Session directory: ${sessionDir} (session-scoped scratch space for temporary files and artifacts)`,
        "- Current date: 2026-10-21",
      ].join("\n")
    );
  });

  test("reads the date when it renders, not when it is constructed", async () => {
    let now = new Date(2026, 9, 21, 23, 55);
    const manager = makeManager();
    await manager.add(
      new EnvironmentExtension({ id: "environment", clock: () => now })
    );

    const before = manager.renderInstructions();
    now = new Date(2026, 9, 22, 0, 5);
    const after = manager.renderInstructions();

    expect(before).toContain("- Current date: 2026-10-21");
    expect(after).toContain("- Current date: 2026-10-22");
  });

  test("leaves everything before the session block alone when the date turns", async () => {
    let now = new Date(2026, 9, 21, 23, 55);
    const manager = makeManager();
    await manager.add(
      new EnvironmentExtension({ id: "environment", clock: () => now })
    );
    await manager.add(new SectionExtension("project", 0, "project notes"));

    const before = manager.renderInstructions();
    now = new Date(2026, 9, 22, 0, 5);
    const after = manager.renderInstructions();
    expect(beforeSession(after)).toBe(beforeSession(before));
    expect(after).not.toBe(before);
  });

  test("keeps the same prefix in two sessions of one project", async () => {
    const one = makeManager("/sessions/one");
    const other = makeManager("/sessions/two");
    await one.add(
      new EnvironmentExtension({ id: "environment", clock: fixedClock })
    );
    await other.add(
      new EnvironmentExtension({ id: "environment", clock: fixedClock })
    );

    const first = one.renderInstructions();
    const second = other.renderInstructions();

    expect(first).not.toBe(second);
    expect(beforeSession(first)).toBe(beforeSession(second));
    expect(first).toContain("- Session directory: /sessions/one");
    expect(second).toContain("- Session directory: /sessions/two");
  });

  test("runs after the subagent catalogue", async () => {
    const manager = makeManager();
    await manager.add(
      new SectionExtension("catalogue", 90, "## Available Subagents")
    );
    await manager.add(new EnvironmentExtension({ id: "environment" }));

    const prompt = manager.renderInstructions();

    expect(prompt.indexOf("## Available Subagents")).toBeLessThan(
      prompt.indexOf(SESSION_HEADING)
    );
  });

  test("lists every project directory and marks the primary one", () => {
    const rendered = renderEnvironment(
      {
        backend: "host",
        cwd: "/repo",
        roots: ["/repo", "/other", sessionDir],
        shells: ["bash"],
      },
      sessionDir,
      {
        operatingSystem: "darwin 27.0.0",
        architecture: "arm64",
        shell: "/bin/zsh",
        nodeVersion: "v22.0.0",
      }
    );

    expect(rendered).toContain(
      [
        "- Project directories:",
        "  - /repo (primary; relative paths resolve here)",
        "  - /other",
      ].join("\n")
    );
  });

  test("renders the sandbox note only when the sandbox has one", () => {
    const info = {
      operatingSystem: "linux 6.8",
      architecture: "x64",
      shell: "/bin/zsh",
      nodeVersion: "v22.0.0",
    };

    const confined = renderEnvironment(
      {
        backend: "seatbelt",
        cwd: "/repo",
        roots: ["/repo", sessionDir],
        shells: ["bash"],
        note: "Writes are limited to the project directories.",
      },
      sessionDir,
      info
    );
    expect(confined).toContain(
      "- Sandbox: Writes are limited to the project directories."
    );

    // 本机直跑没有约束可讲，系统提示一个字都不变。
    const open = renderEnvironment(
      {
        backend: "host",
        cwd: "/repo",
        roots: ["/repo", sessionDir],
        shells: ["bash"],
      },
      sessionDir,
      info
    );
    expect(open).not.toContain("- Sandbox:");
  });

  test("renders before sections with a higher priority number", async () => {
    const manager = makeManager();

    // 后注册但优先级更高（数值更小），仍然排在前面。
    await manager.add(new SectionExtension("project", 0, "project notes"));
    await manager.add(new EnvironmentExtension({ id: "environment" }));

    const prompt = manager.renderInstructions("base");

    expect(prompt.indexOf("## Environment")).toBeLessThan(
      prompt.indexOf("project notes")
    );
  });

  test("defaults to a priority above every other built-in section", async () => {
    const manager = makeManager();

    await manager.add(new EnvironmentExtension({ id: "environment" }));

    const [section] = manager.listSections();
    expect(section?.id).toBe("environment:environment");
    expect(section?.priority).toBe(-10);
  });

  test("renders Bot workspace directory as cwd when no project is attached", () => {
    const botWorkspaceDir = "/home/user/.aify-zero/bots/b1/workspace";
    const rendered = renderEnvironment(
      {
        backend: "host",
        cwd: botWorkspaceDir,
        roots: [
          botWorkspaceDir,
          sessionDir,
          "/home/user/.aify-zero/bots/b1/skills",
        ],
        shells: ["bash"],
      },
      sessionDir,
      {
        operatingSystem: "darwin 27.0.0",
        architecture: "arm64",
        shell: "/bin/zsh",
        nodeVersion: "v22.0.0",
      },
      {
        botWorkspaceDir,
        projectDirs: [botWorkspaceDir],
      }
    );

    expect(rendered).toContain(
      `- Bot workspace directory: ${botWorkspaceDir} (relative paths resolve here)`
    );
    expect(rendered).not.toContain("Project director");
    expect(rendered).not.toContain("skills");
  });

  test("renders Project directory alongside Bot workspace directory when a project is attached", () => {
    const botWorkspaceDir = "/home/user/.aify-zero/bots/b1/workspace";
    const rendered = renderEnvironment(
      {
        backend: "host",
        cwd: "/repo",
        roots: ["/repo", botWorkspaceDir, sessionDir, "/bots/b1/skills"],
        shells: ["bash"],
      },
      sessionDir,
      {
        operatingSystem: "darwin 27.0.0",
        architecture: "arm64",
        shell: "/bin/zsh",
        nodeVersion: "v22.0.0",
      },
      {
        botWorkspaceDir,
        projectDirs: ["/repo", botWorkspaceDir],
      }
    );

    expect(rendered).toContain(
      "- Project directory: /repo (relative paths resolve here)"
    );
    expect(rendered).toContain(
      `- Bot workspace directory: ${botWorkspaceDir} (persistent workspace for this Bot)`
    );
    expect(rendered).not.toContain("skills");
  });
});
