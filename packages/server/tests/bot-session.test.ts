import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { DEFAULT_BOT_ID } from "@workspace/agent-client";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type { AppRouterClient } from "../src/routers/index";
import type { SQLiteStore } from "../src/storage/sqlite-store";

const dir = mkdtempSync(path.join(tmpdir(), "aify-bot-session-"));
process.env.DATABASE_URL = `file:${path.join(dir, "test.db")}`;
process.env.HOME = dir;
process.env.AIFY_DATA_DIR = path.join(dir, ".aify-zero");

const API_TOKEN = "test-api-token";

let client: AppRouterClient;
let store: SQLiteStore;
let projectDir: string;
let projectId: string;

const TEST_MODEL = { providerId: "test-provider", modelId: "test-model" };

describe("bot session integration", () => {
  beforeAll(async () => {
    const { migrateDb } = await import("@workspace/db");
    await migrateDb();

    const { createApp } = await import("../src/app");
    const app = createApp({ apiToken: () => API_TOKEN });

    const storeModule = await import("../src/storage/sqlite-store");
    store = new storeModule.SQLiteStore();

    client = createORPCClient(
      new RPCLink({
        url: "http://aify.test/api/rpc",
        headers: { authorization: `Bearer ${API_TOKEN}` },
        fetch: async (request) => await app.request(request),
      })
    );

    await client.setting.update({
      providers: [
        {
          id: TEST_MODEL.providerId,
          name: "Test",
          protocol: "openai-chat",
          baseURL: "http://127.0.0.1:9/v1",
          apiKey: "test",
          active: true,
          models: [{ id: TEST_MODEL.modelId, name: "Test", active: true }],
        },
      ],
    });

    projectDir = path.join(dir, "sample-project");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(path.join(projectDir, "AGENTS.md"), "Project rules");
    mkdirSync(path.join(projectDir, ".agents", "skills", "proj-skill"), {
      recursive: true,
    });
    writeFileSync(
      path.join(projectDir, ".agents", "skills", "proj-skill", "SKILL.md"),
      "---\nname: proj-skill\ndescription: project skill\n---\nbody\n"
    );

    const createdProject = await client.project.create({
      name: "Sample Project",
      primaryDir: projectDir,
      additionalDirs: [],
    });
    if (!createdProject) {
      throw new Error("Expected created project");
    }
    projectId = createdProject.id;
  });

  afterAll(async () => {
    const { closeDb } = await import("@workspace/db");
    closeDb();
    rmSync(dir, { recursive: true, force: true });
  });

  test("resolves unattached session directories to Bot Workspace and attaches Bot Workspace with Project", async () => {
    const { resolveSessionDirectories } =
      await import("../src/session/directories");
    const { resolveSessionWorkspace } =
      await import("../src/routers/workspace/workspace.service");

    const { bot } = await client.bot.create({ name: "Dir Bot" });
    await store.saveSession({
      id: "dir-unattached",
      botId: bot.id,
      title: "Unattached",
      metadata: {},
    });
    await store.saveSession({
      id: "dir-attached",
      botId: bot.id,
      projectId,
      title: "Attached",
      metadata: {},
    });

    const unattached = await resolveSessionDirectories({ botId: bot.id });
    const unattachedWs = await resolveSessionWorkspace("dir-unattached");
    const attached = await resolveSessionDirectories({
      botId: bot.id,
      projectId,
    });
    const attachedWs = await resolveSessionWorkspace("dir-attached");

    expect(unattached.hasProject).toBeFalsy();
    expect(unattachedWs.primaryDir).toBe(bot.workspaceDir);
    expect(attached.hasProject).toBeTruthy();
    expect(attachedWs.primaryDir).toBe(projectDir);
    expect(attachedWs.roots).toContain(bot.workspaceDir);
  });

  test("createSession seeds Bot defaults on insert and listSessions filters by botId", async () => {
    const { bot } = await client.bot.create({
      name: "Seeded Bot",
      defaultProjectId: projectId,
      defaultApprovalPolicy: "readonly",
    });

    await client.session.createSession({
      sessionId: "seeded-s1",
      botId: bot.id,
      model: TEST_MODEL,
      turns: [
        {
          id: "t1",
          type: "user",
          createdAt: Date.now(),
          status: "done",
          content: [
            {
              id: "st1",
              type: "user",
              createdAt: Date.now(),
              status: "done",
              content: [{ type: "text", text: "hi", createdAt: Date.now() }],
            },
          ],
        },
      ],
    });

    const { session } = await client.session.getSession({
      sessionId: "seeded-s1",
    });
    const filtered = await client.session.listSessions({
      botId: bot.id,
      direction: "desc",
    });
    const defaultOnly = await client.session.listSessions({
      botId: DEFAULT_BOT_ID,
      direction: "desc",
    });

    expect(session?.botId).toBe(bot.id);
    expect(session?.projectId).toBe(projectId);
    expect(session?.approvalPolicy).toBe("readonly");
    expect(filtered.sessions.map((row) => row.id)).toContain("seeded-s1");
    expect(defaultOnly.sessions.map((row) => row.id)).not.toContain(
      "seeded-s1"
    );
  });

  test("createSession rejects unknown botId with BOT_NOT_FOUND", async () => {
    await expect(
      client.session.createSession({
        sessionId: "missing-bot-s1",
        botId: "no-such-bot",
        model: TEST_MODEL,
        turns: [
          {
            id: "t2",
            type: "user",
            createdAt: Date.now(),
            status: "done",
            content: [
              {
                id: "st2",
                type: "user",
                createdAt: Date.now(),
                status: "done",
                content: [{ type: "text", text: "hi", createdAt: Date.now() }],
              },
            ],
          },
        ],
      })
    ).rejects.toMatchObject({ code: "BOT_NOT_FOUND" });
  });

  test("listSessionResources respects Bot skills and context isolation", async () => {
    const globalSkillDir = path.join(dir, ".agents", "skills", "global-sample");
    mkdirSync(globalSkillDir, { recursive: true });
    writeFileSync(
      path.join(globalSkillDir, "SKILL.md"),
      "---\nname: global-sample\ndescription: global sample\n---\nbody\n"
    );
    mkdirSync(path.join(dir, ".agents"), { recursive: true });
    writeFileSync(path.join(dir, ".agents", "AGENTS.md"), "Global agents");

    const { bot } = await client.bot.create({
      name: "Isolated Res Bot",
      includeGlobalContext: false,
      skills: { globalMode: "none", globalNames: [] },
    });
    mkdirSync(path.join(bot.skillsDir, "bot-only"), { recursive: true });
    writeFileSync(
      path.join(bot.skillsDir, "bot-only", "SKILL.md"),
      "---\nname: bot-only\ndescription: bot skill\n---\nbody\n"
    );
    writeFileSync(path.join(bot.homeDir, "AGENTS.md"), "Bot agents");

    const resources = await client.session.listSessionResources({
      sessionId: "draft-res",
      botId: bot.id,
    });

    expect(resources.skills.map((skill) => skill.name)).toStrictEqual([
      "bot-only",
    ]);
    expect(resources.context.map((file) => file.content)).toStrictEqual([
      "Bot agents",
    ]);
  });

  test("buildSessionAgent applies Bot instructions, disabled tool groups, isolated HOME, and env", async () => {
    const { AgentSession, SessionEventRegistry, StreamEventRegistry } =
      await import("@workspace/agent");
    const { buildSessionAgent } = await import("../src/session/agent");
    const { findConfiguredModel } =
      await import("../src/routers/settings/settings.service");

    const configured = await findConfiguredModel(TEST_MODEL);
    if (!configured) {
      throw new Error("Expected configured test model");
    }

    const { bot } = await client.bot.create({
      name: "Assembly Bot",
      instructions: "Follow Bot rules strictly.",
      toolGroups: {
        files: true,
        shell: false,
        web: false,
        jobs: false,
        timers: false,
        subagent: false,
      },
      sandbox: { adapter: "host", isolateHome: true },
      env: { BOT_SECRET: "xyz" },
    });

    const agent = await buildSessionAgent({
      sessionId: "assembly-s1",
      configured,
      botId: bot.id,
      session: new AgentSession({ turns: [] }),
      store,
      streams: new StreamEventRegistry(new SessionEventRegistry()),
      approvalPolicy: "edit",
    });

    let envOut = "";
    await agent.context.sandbox.exec('printf "%s|%s" "$BOT_SECRET" "$HOME"', {
      onData: (channel, chunk) => {
        if (channel === "stdout") {
          envOut += chunk.toString("utf-8");
        }
      },
    });

    expect(agent.instructions).toContain("Follow Bot rules strictly.");
    expect("bash" in agent.tools).toBeFalsy();
    expect("task" in agent.tools).toBeFalsy();
    expect(agent.context.sandbox.describe().cwd).toBe(bot.workspaceDir);
    expect(envOut).toBe(`xyz|${path.join(bot.homeDir, "home")}`);
  });
});
