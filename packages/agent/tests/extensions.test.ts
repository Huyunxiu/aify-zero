import type { Tool, ToolSet } from "ai";
import { describe, expect, test, vi } from "vitest";

import type { ContextFile } from "../src/context-files.js";
import { ExtensionManager } from "../src/extensions/manager.js";
import type { ExtensionManagerDeps } from "../src/extensions/manager.js";
import { ContextExtension, SkillExtension } from "../src/extensions/plugins.js";
import type { ExtensionAPI } from "../src/extensions/types.js";
import { Extension } from "../src/extensions/types.js";
import { HooksManager } from "../src/hooks-manager.js";
import type { HooksMap } from "../src/hooks-manager.js";
import type { ContextSource, SkillSource } from "../src/resources/types.js";
import type { SkillInfo } from "../src/skill/skill-types.js";

const makeTool = (description: string): Tool =>
  ({ description }) as unknown as Tool;

const makeSkill = (name: string, source: SkillInfo["source"]): SkillInfo => ({
  name,
  description: `${name} description`,
  location: `${source}/${name}/SKILL.md`,
  dir: ".agents",
  content: "",
  category: "project",
  metadata: {},
  source,
});

const skillSource = (skills: SkillInfo[]): SkillSource => ({
  load: () => Promise.resolve(skills),
});

const contextSource = (files: ContextFile[]): ContextSource => ({
  load: () => Promise.resolve(files),
});

/** 用一组回调拼出测试用扩展，省掉为每种场景写一个子类。 */
class TestExtension extends Extension {
  readonly #init: (api: ExtensionAPI) => void | Promise<void>;
  readonly #dispose?: () => void | Promise<void>;

  constructor(
    id: string,
    init: (api: ExtensionAPI) => void | Promise<void>,
    dispose?: () => void | Promise<void>
  ) {
    super({ id });
    this.#init = init;
    this.#dispose = dispose;
  }

  init(api: ExtensionAPI): void | Promise<void> {
    return this.#init(api);
  }

  dispose(): void | Promise<void> {
    return this.#dispose?.();
  }
}

const makeDeps = () => {
  const tools: ToolSet = {};
  const hooks = new HooksManager();
  const deps: ExtensionManagerDeps = {
    agent: {
      name: "main",
      sessionId: "session-1",
      projectDirs: ["/repo"],
      sessionDir: "/sessions/session-1",
    },
    tools,
    registerTool: (name, tool) => {
      tools[name] = tool;
    },
    unregisterTool: (name) => {
      Reflect.deleteProperty(tools, name);
    },
    hooks,
  };

  return { deps, tools, hooks };
};

const emitSessionStart = (hooks: HooksManager) =>
  hooks.emit(
    "session_start",
    {
      sessionId: "session-1",
      name: "main",
      projectDirs: ["/repo"],
      sessionDir: "/sessions/session-1",
    },
    {}
  );

describe(ExtensionManager, () => {
  test("rejects an extension id that is already registered", async () => {
    const { deps } = makeDeps();
    const manager = new ExtensionManager(deps);

    await manager.add(new TestExtension("same", () => {}));
    await expect(
      manager.add(new TestExtension("same", () => {}))
    ).rejects.toThrow('extension "same" is already registered');
  });

  test("rejects a tool that another extension owns unless it overrides", async () => {
    const { deps, tools } = makeDeps();
    const manager = new ExtensionManager(deps);
    const first = makeTool("first");
    const second = makeTool("second");
    const third = makeTool("third");

    await manager.add(
      new TestExtension("first", (api) => api.tool("shared", first))
    );

    await expect(
      manager.add(
        new TestExtension("second", (api) => api.tool("shared", second))
      )
    ).rejects.toThrow('tool "shared" is already registered');

    await manager.add(
      new TestExtension("third", (api) =>
        api.tool("shared", third, { override: true })
      )
    );

    expect(tools.shared).toBe(third);
  });

  test("applies prompt sections by priority, then registration order", async () => {
    const { deps } = makeDeps();
    const manager = new ExtensionManager(deps);

    await manager.add(
      new TestExtension("first", (api) => {
        api.systemPromptSection({
          id: "late",
          priority: 10,
          render: (prompt) => `${prompt}A`,
        });
        api.systemPromptSection({
          id: "early",
          priority: 0,
          render: (prompt) => `${prompt}B`,
        });
      })
    );
    await manager.add(
      new TestExtension("second", (api) =>
        api.systemPromptSection({
          id: "same-priority",
          render: (prompt) => `${prompt}C`,
        })
      )
    );

    expect(manager.renderSystemPrompt("base")).toBe("baseBCA");
    expect(manager.listSections().map((section) => section.id)).toStrictEqual([
      "early",
      "same-priority",
      "late",
    ]);
  });

  test("rejects a prompt section id that is already registered", async () => {
    const { deps } = makeDeps();
    const manager = new ExtensionManager(deps);

    await manager.add(
      new TestExtension("first", (api) =>
        api.systemPromptSection({
          id: "shared",
          render: (prompt) => prompt,
        })
      )
    );

    await expect(
      manager.add(
        new TestExtension("second", (api) =>
          api.systemPromptSection({
            id: "shared",
            render: (prompt) => prompt,
          })
        )
      )
    ).rejects.toThrow('system prompt section "shared" is already registered');
  });

  test("removes tools and sections when an extension is disposed", async () => {
    const { deps, tools } = makeDeps();
    const manager = new ExtensionManager(deps);
    const tool = makeTool("owned");

    await manager.add(
      new TestExtension("owned", (api) => {
        api.tool("owned-tool", tool);
        api.systemPromptSection({
          id: "owned-section",
          render: (prompt) => `${prompt}owned`,
        });
      })
    );

    expect(tools["owned-tool"]).toBe(tool);
    expect(manager.listSections()).toHaveLength(1);

    await expect(manager.dispose("owned")).resolves.toBeTruthy();

    expect(tools["owned-tool"]).toBeUndefined();
    expect(manager.listSections()).toStrictEqual([]);
  });

  test("stops listening to hooks and calls dispose once", async () => {
    const { deps, hooks } = makeDeps();
    const manager = new ExtensionManager(deps);
    const handler = vi.fn<HooksMap["session_start"]>();
    const dispose = vi.fn<() => void>();

    await manager.add(
      new TestExtension(
        "owned",
        (api) => api.on("session_start", handler),
        dispose
      )
    );

    await emitSessionStart(hooks);
    expect(handler).toHaveBeenCalledOnce();

    await manager.dispose("owned");
    expect(dispose).toHaveBeenCalledOnce();

    await emitSessionStart(hooks);
    expect(handler).toHaveBeenCalledOnce();

    await expect(manager.dispose("owned")).resolves.toBeFalsy();
  });

  test("does not remove a tool that a later extension overrode", async () => {
    const { deps, tools } = makeDeps();
    const manager = new ExtensionManager(deps);
    const original = makeTool("original");
    const replacement = makeTool("replacement");

    await manager.add(
      new TestExtension("original", (api) => api.tool("shared", original))
    );
    await manager.add(
      new TestExtension("replacement", (api) =>
        api.tool("shared", replacement, { override: true })
      )
    );

    await manager.dispose("original");

    expect(tools.shared).toBe(replacement);
  });

  test("rolls back contributions when init throws", async () => {
    const { deps, tools, hooks } = makeDeps();
    const manager = new ExtensionManager(deps);
    const handler = vi.fn<HooksMap["session_start"]>();

    await expect(
      manager.add(
        new TestExtension("broken", (api) => {
          api.tool("broken-tool", makeTool("broken"));
          api.on("session_start", handler);
          api.systemPromptSection({
            id: "broken-section",
            render: (prompt) => prompt,
          });
          throw new Error("boom");
        })
      )
    ).rejects.toThrow("boom");

    expect(tools["broken-tool"]).toBeUndefined();
    expect(manager.listSections()).toStrictEqual([]);

    await emitSessionStart(hooks);
    expect(handler).not.toHaveBeenCalled();

    expect(manager.renderSystemPrompt("base")).toBe("base");
  });

  test("disposes every extension in reverse registration order", async () => {
    const { deps } = makeDeps();
    const manager = new ExtensionManager(deps);
    const order: string[] = [];

    await manager.add(
      new TestExtension(
        "first",
        () => {},
        () => {
          order.push("first");
        }
      )
    );
    await manager.add(
      new TestExtension(
        "second",
        () => {},
        () => {
          order.push("second");
        }
      )
    );

    await manager.disposeAll();

    expect(order).toStrictEqual(["second", "first"]);
    expect(manager.listSections()).toStrictEqual([]);
  });
});

describe(SkillExtension, () => {
  test("loads its sources and contributes a skills section", async () => {
    const { deps } = makeDeps();
    const manager = new ExtensionManager(deps);
    const extension = new SkillExtension({
      id: "skills",
      sources: [skillSource([makeSkill("review", "filesystem")])],
      dirs: [".agents"],
    });

    await manager.add(extension);

    expect(
      extension.manager.listUserAvailableSkills().map((skill) => skill.name)
    ).toStrictEqual(["review"]);
    expect(manager.renderSystemPrompt("base")).toBe(
      "base\n## Available Skills\n- **review**: review description"
    );
  });

  test("loads with the agent's primary project directory", async () => {
    const { deps } = makeDeps();
    const manager = new ExtensionManager(deps);
    const projectDirs: string[] = [];

    await manager.add(
      new SkillExtension({
        id: "skills",
        sources: [
          {
            load: (context) => {
              projectDirs.push(context.projectDir);
              return Promise.resolve([]);
            },
          },
        ],
      })
    );

    expect(projectDirs).toStrictEqual(["/repo"]);
  });
});

describe(ContextExtension, () => {
  test("renders its files into the prompt", async () => {
    const { deps } = makeDeps();
    const manager = new ExtensionManager(deps);

    await manager.add(
      new ContextExtension({
        id: "context",
        sources: [
          contextSource([
            { path: "/repo/AGENTS.md", content: "Always run the tests." },
          ]),
        ],
      })
    );

    expect(manager.renderSystemPrompt("base")).toBe(
      [
        "base",
        "",
        "Project-specific instructions and guidelines:",
        "",
        '<project_instructions path="/repo/AGENTS.md">',
        "Always run the tests.",
        "</project_instructions>",
      ].join("\n")
    );
  });

  test("registers no section when every source is empty", async () => {
    const { deps } = makeDeps();
    const manager = new ExtensionManager(deps);

    await manager.add(
      new ContextExtension({
        id: "context",
        sources: [contextSource([])],
      })
    );

    expect(manager.listSections()).toStrictEqual([]);
  });
});
