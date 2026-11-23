import type { ToolSet } from "ai";
import { describe, expect, test } from "vitest";

import {
  ApprovalPolicyExtension,
  renderApprovalNotice,
} from "../src/extensions/builtin/approval-notice.js";
import { ExtensionManager } from "../src/extensions/manager.js";
import { HooksManager } from "../src/hooks-manager.js";
import { testSandbox } from "./helpers/sandbox.js";

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
    environment: {
      sessionId: "session-1",
      projectDirs: [projectDir],
      primaryProjectDir: projectDir,
      sessionDir,
      sandbox: testSandbox(projectDir, sessionDir),
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

describe(renderApprovalNotice, () => {
  test("names the classes a read-only session refuses", () => {
    const notice = renderApprovalNotice("readonly");

    expect(notice).toContain(
      "This session refuses writes to disk and shell commands before the call runs."
    );
    expect(notice).toContain(
      "When a call is refused, tell the user what stopped it."
    );
  });

  test("says nothing about a session that refuses nothing", () => {
    expect(renderApprovalNotice("edit")).toBeUndefined();
    expect(renderApprovalNotice("unrestricted")).toBeUndefined();
  });
});

describe(ApprovalPolicyExtension, () => {
  test("adds the notice to a read-only session's prompt", async () => {
    const manager = makeManager();
    await manager.add(
      new ApprovalPolicyExtension({ id: "approval", policy: "readonly" })
    );

    const prompt = manager.renderInstructions("base");

    expect(prompt.startsWith("base\n\n")).toBeTruthy();
    expect(prompt).toContain("This session refuses writes to disk");
  });

  test("leaves a session that refuses nothing with its prompt unchanged", async () => {
    for (const policy of ["edit", "unrestricted"] as const) {
      const manager = makeManager();
      await manager.add(
        new ApprovalPolicyExtension({ id: "approval", policy })
      );

      expect(manager.renderInstructions("base")).toBe("base");
    }
  });
});
