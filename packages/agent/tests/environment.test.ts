import type { ToolSet } from "ai";
import { describe, expect, test } from "vitest";

import {
  EnvironmentExtension,
  renderEnvironment,
} from "../src/extensions/environment.js";
import { ExtensionManager } from "../src/extensions/manager.js";
import type { ExtensionAPI } from "../src/extensions/types.js";
import { Extension } from "../src/extensions/types.js";
import { HooksManager } from "../src/hooks-manager.js";

const projectDir = "/repo";
const sessionDir = "/home/user/.aify-zero/sessions/session-1";

const makeManager = (): ExtensionManager => {
  const tools: ToolSet = {};

  return new ExtensionManager({
    agent: {
      name: "main",
      sessionId: "session-1",
      projectDirs: [projectDir],
      sessionDir,
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
      render: (prompt) => `${prompt}\n\n${this.#text}`,
    });
  }
}

describe(EnvironmentExtension, () => {
  test("renders both directories and the detected system info", async () => {
    const manager = makeManager();

    await manager.add(
      new EnvironmentExtension({
        id: "environment",
        // 10 月是 9，验证本地日期格式化成 YYYY-MM-DD。
        now: new Date(2026, 9, 21),
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
        "# Environment",
        "",
        `- Project directory: ${projectDir} (relative paths resolve here)`,
        `- Session directory: ${sessionDir} (session-scoped scratch space for temporary files and artifacts)`,
        "- Operating system: linux 6.8",
        "- Architecture: x64",
        "- Shell: /bin/zsh",
        "- Node.js: v22.0.0",
        "- Current date: 2026-10-21",
      ].join("\n")
    );
  });

  test("lists every project directory and marks the primary one", () => {
    const rendered = renderEnvironment(["/repo", "/other"], sessionDir, {
      operatingSystem: "darwin 27.0.0",
      architecture: "arm64",
      shell: "/bin/zsh",
      nodeVersion: "v22.0.0",
      date: "2026-10-21",
    });

    expect(rendered).toContain(
      [
        "- Project directories:",
        "  - /repo (primary; relative paths resolve here)",
        "  - /other",
      ].join("\n")
    );
  });

  test("renders before sections with a higher priority number", async () => {
    const manager = makeManager();

    // 后注册但优先级更高（数值更小），仍然排在前面。
    await manager.add(new SectionExtension("project", 0, "project notes"));
    await manager.add(new EnvironmentExtension({ id: "environment" }));

    const prompt = manager.renderInstructions("base");

    expect(prompt.indexOf("# Environment")).toBeLessThan(
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
});
