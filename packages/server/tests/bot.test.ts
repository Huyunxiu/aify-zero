import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { DEFAULT_BOT_ID } from "@workspace/agent-client";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type { AppRouterClient } from "../src/routers/index";
import type { SQLiteStore } from "../src/storage/sqlite-store";

const dir = mkdtempSync(path.join(tmpdir(), "aify-bot-router-"));
process.env.DATABASE_URL = `file:${path.join(dir, "test.db")}`;
process.env.HOME = dir;
process.env.AIFY_DATA_DIR = path.join(dir, ".aify-zero");

const API_TOKEN = "test-api-token";

let client: AppRouterClient;
let store: SQLiteStore;

describe("bot router", () => {
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
  });

  afterAll(async () => {
    const { closeDb } = await import("@workspace/db");
    closeDb();
    rmSync(dir, { recursive: true, force: true });
  });

  test("lists Default Bot pinned first alongside created Bots", async () => {
    await client.bot.create({ name: "Alpha Bot" });
    const { bots } = await client.bot.list();

    expect(bots.length).toBeGreaterThanOrEqual(2);
    expect(bots[0]?.id).toBe(DEFAULT_BOT_ID);
    expect(bots[0]?.isDefault).toBeTruthy();
    expect(bots.some((bot) => bot.name === "Alpha Bot")).toBeTruthy();
  });

  test("masks plaintext env on get and creates Bot Home directories", async () => {
    const { bot } = await client.bot.create({
      name: "Secret Bot",
      env: { ZEBRA_KEY: "secret-z", ALPHA_KEY: "secret-a" },
    });
    const fetched = await client.bot.get({ botId: bot.id });

    expect(fetched.bot.envKeys).toStrictEqual(["ALPHA_KEY", "ZEBRA_KEY"]);
    expect("env" in fetched.bot).toBeFalsy();
    expect(existsSync(fetched.bot.homeDir)).toBeTruthy();
    expect(existsSync(fetched.bot.workspaceDir)).toBeTruthy();
    expect(existsSync(fetched.bot.skillsDir)).toBeTruthy();
  });

  test("applies envPatch to add, overwrite, and delete keys", async () => {
    const { bot } = await client.bot.create({
      name: "Patch Bot",
      env: { KEEP_ME: "old", DROP_ME: "bye" },
    });

    const { bot: updated } = await client.bot.update({
      botId: bot.id,
      envPatch: {
        KEEP_ME: "new",
        ADD_ME: "added",
        DROP_ME: null,
      },
    });

    const { findBotById } = await import("../src/routers/bot/bot.repository");
    const row = await findBotById(bot.id);

    expect(updated.envKeys).toStrictEqual(["ADD_ME", "KEEP_ME"]);
    expect(row?.env).toStrictEqual({ KEEP_ME: "new", ADD_ME: "added" });
  });

  test("forces jobs off when shell tool group is disabled", async () => {
    const { bot } = await client.bot.create({
      name: "No Shell Bot",
      toolGroups: {
        files: true,
        shell: false,
        web: true,
        jobs: true,
        timers: true,
        subagent: true,
      },
    });

    expect(bot.toolGroups.shell).toBeFalsy();
    expect(bot.toolGroups.jobs).toBeFalsy();
  });

  test("rejects duplicate MCP server IDs across global settings and Bots", async () => {
    await client.setting.update({
      mcpServers: [
        {
          id: "global-mcp-1",
          name: "sharedname",
          enabled: true,
          autoApprove: false,
          transport: {
            type: "http",
            url: "https://example.com/a",
            headers: {},
          },
        },
      ],
    });

    await expect(
      client.bot.create({
        name: "Dup Id Bot",
        mcp: {
          globalMode: "selected",
          globalServerIds: [],
          servers: [
            {
              id: "global-mcp-1",
              name: "othername",
              enabled: true,
              autoApprove: false,
              transport: {
                type: "http",
                url: "https://example.com/b",
                headers: {},
              },
            },
          ],
        },
      })
    ).rejects.toMatchObject({ code: "MCP_SERVER_DUPLICATE" });

    const { bot: validBot } = await client.bot.create({
      name: "Unique Private MCP Bot",
      mcp: {
        globalMode: "selected",
        globalServerIds: [],
        servers: [
          {
            id: "bot-priv-1",
            name: "privserver",
            enabled: true,
            autoApprove: false,
            transport: {
              type: "http",
              url: "https://example.com/p",
              headers: {},
            },
          },
        ],
      },
    });

    await expect(
      client.setting.update({
        mcpServers: [
          {
            id: validBot.mcp.servers[0]!.id,
            name: "collidingid",
            enabled: true,
            autoApprove: false,
            transport: {
              type: "http",
              url: "https://example.com/c",
              headers: {},
            },
          },
        ],
      })
    ).rejects.toMatchObject({ code: "MCP_SERVER_DUPLICATE" });
  });

  test("rejects duplicate MCP names in a Bot effective set but allows shared private names across distinct Bots", async () => {
    await expect(
      client.bot.create({
        name: "Effective Dup Name",
        mcp: {
          globalMode: "selected",
          globalServerIds: ["global-mcp-1"],
          servers: [
            {
              id: "priv-dup-name",
              name: "sharedname",
              enabled: true,
              autoApprove: false,
              transport: {
                type: "http",
                url: "https://example.com/d",
                headers: {},
              },
            },
          ],
        },
      })
    ).rejects.toMatchObject({ code: "MCP_SERVER_DUPLICATE" });

    const first = await client.bot.create({
      name: "Shared Priv Name A",
      mcp: {
        globalMode: "selected",
        globalServerIds: [],
        servers: [
          {
            id: "priv-a-1",
            name: "github",
            enabled: true,
            autoApprove: false,
            transport: {
              type: "http",
              url: "https://example.com/gh1",
              headers: {},
            },
          },
        ],
      },
    });

    const second = await client.bot.create({
      name: "Shared Priv Name B",
      mcp: {
        globalMode: "selected",
        globalServerIds: [],
        servers: [
          {
            id: "priv-b-1",
            name: "github",
            enabled: true,
            autoApprove: false,
            transport: {
              type: "http",
              url: "https://example.com/gh2",
              headers: {},
            },
          },
        ],
      },
    });

    expect(first.bot.mcp.servers[0]?.name).toBe("github");
    expect(second.bot.mcp.servers[0]?.name).toBe("github");
  });

  test("forbids deleting Default Bot", async () => {
    await expect(
      client.bot.delete({ botId: DEFAULT_BOT_ID })
    ).rejects.toMatchObject({ code: "CANNOT_DELETE_DEFAULT_BOT" });
  });

  test("rejects deleting a Bot when any of its sessions is running or waiting review", async () => {
    const { bot } = await client.bot.create({ name: "Busy Bot" });
    await store.saveSession({
      id: "busy-bot-s1",
      botId: bot.id,
      title: "Waiting review",
      metadata: {},
      status: "wait_review",
    });

    await expect(client.bot.delete({ botId: bot.id })).rejects.toMatchObject({
      code: "BOT_BUSY",
    });

    const fetched = await client.bot.get({ botId: bot.id });
    expect(fetched.bot.id).toBe(bot.id);
    const sessionRow = await store.getSessionById("busy-bot-s1");
    expect(sessionRow?.id).toBe("busy-bot-s1");
  });

  test("cascades soft-deletion, clears MCP credentials, and preserves files unless deleteFiles is true", async () => {
    const { mcpCredentialStore, hasMcpTokens } =
      await import("../src/mcp/credentials");

    const { bot: keepFilesBot } = await client.bot.create({
      name: "Keep Files Bot",
      mcp: {
        globalMode: "selected",
        globalServerIds: [],
        servers: [
          {
            id: "keep-bot-mcp",
            name: "keepmcp",
            enabled: true,
            autoApprove: false,
            transport: {
              type: "http",
              url: "https://example.com/keep",
              headers: {},
            },
          },
        ],
      },
    });
    await mcpCredentialStore.write("keep-bot-mcp", "tokens", {
      access_token: "secret",
    });
    await store.saveSession({
      id: "keep-bot-s1",
      botId: keepFilesBot.id,
      title: "Done session",
      metadata: {},
      status: "done",
    });
    writeFileSync(
      path.join(keepFilesBot.workspaceDir, "note.txt"),
      "preserve me"
    );

    await client.bot.delete({ botId: keepFilesBot.id });

    expect(existsSync(keepFilesBot.homeDir)).toBeTruthy();
    await expect(hasMcpTokens("keep-bot-mcp")).resolves.toBeFalsy();
    await expect(store.getSessionById("keep-bot-s1")).resolves.toBeNull();

    const { bot: wipeFilesBot } = await client.bot.create({
      name: "Wipe Files Bot",
    });
    mkdirSync(wipeFilesBot.workspaceDir, { recursive: true });
    await client.bot.delete({ botId: wipeFilesBot.id, deleteFiles: true });

    expect(existsSync(wipeFilesBot.homeDir)).toBeFalsy();
  });

  test("listSkills deduplicates global skills across multiple global directories", async () => {
    const aifySkillDir = path.join(dir, ".aify-studio", "skills", "dup-skill");
    const agentsSkillDir = path.join(dir, ".agents", "skills", "dup-skill");
    mkdirSync(aifySkillDir, { recursive: true });
    mkdirSync(agentsSkillDir, { recursive: true });
    writeFileSync(
      path.join(aifySkillDir, "SKILL.md"),
      "---\nname: dup-skill\ndescription: studio wins\n---\nbody\n"
    );
    writeFileSync(
      path.join(agentsSkillDir, "SKILL.md"),
      "---\nname: dup-skill\ndescription: agents loses\n---\nbody\n"
    );

    const { globalSkills } = await client.bot.listSkills({
      botId: DEFAULT_BOT_ID,
    });
    const matches = globalSkills.filter((skill) => skill.name === "dup-skill");

    expect(matches).toHaveLength(1);
    expect(matches[0]?.description).toBe("studio wins");
  });
});
