import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";

import { afterEach, describe, expect, test } from "vitest";

import type { McpServerConfig } from "../../src/mcp/config.js";
import { McpManager } from "../../src/mcp/manager.js";
import { completeMcpAuthorization } from "../../src/mcp/oauth/authorize.js";
import { McpAuthorizationFlows } from "../../src/mcp/oauth/flows.js";
import { McpOAuthProvider } from "../../src/mcp/oauth/provider.js";
import { createMemoryCredentialStore } from "./helpers/memory-credential-store.js";

const ACCESS_TOKEN = "mcp-access-token";
const REFRESH_TOKEN = "mcp-refresh-token";
const AUTHORIZATION_CODE = "authorization-code";
const CLIENT_ID = "fake-client";
const REDIRECT_URL = "http://127.0.0.1:18086/api/mcp/oauth/callback";

type FakeAuthorizationServer = {
  origin: string;
  close(): Promise<void>;
};

/** 收完请求体；表单与 JSON 都从字符串再解析。 */
function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    request.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf-8"));
    });
    request.on("error", reject);
  });
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
): void {
  response.writeHead(status, {
    "content-type": "application/json",
    ...headers,
  });
  response.end(JSON.stringify(body));
}

function sendStatus(response: ServerResponse, status: number): void {
  response.writeHead(status);
  response.end();
}

/** 最小的 MCP 端点：没有令牌回 401，有令牌只认 initialize 与 tools/list。 */
function handleMcp(
  request: IncomingMessage,
  response: ServerResponse,
  body: string,
  origin: string
): void {
  if (request.headers.authorization !== `Bearer ${ACCESS_TOKEN}`) {
    sendJson(
      response,
      401,
      { error: "unauthorized" },
      {
        "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
      }
    );
    return;
  }

  const message = JSON.parse(body) as {
    id?: number | string;
    method?: string;
    params?: { protocolVersion?: string };
  };

  // 通知没有 id，按协议回 202。
  if (message.id === undefined) {
    sendStatus(response, 202);
    return;
  }

  const reply = (result: unknown): void => {
    sendJson(response, 200, { jsonrpc: "2.0", id: message.id, result });
  };

  const fail = (code: number, description: string): void => {
    sendJson(response, 200, {
      jsonrpc: "2.0",
      id: message.id,
      error: { code, message: description },
    });
  };

  switch (message.method) {
    case undefined: {
      fail(-32_600, "Invalid request");
      return;
    }
    case "initialize": {
      reply({
        protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "fake-mcp", version: "1.0.0" },
      });
      return;
    }
    case "tools/list": {
      reply({
        tools: [
          {
            name: "echo",
            description: "Echo back the input.",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      });
      return;
    }
    default: {
      // 未知方法回 -32601：协议探测据此退回老式 initialize 流程。
      fail(-32_601, "Method not found");
    }
  }
}

async function startFakeServer(): Promise<FakeAuthorizationServer> {
  const handler = async (
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> => {
    const url = new URL(
      request.url ?? "/",
      `http://${request.headers.host ?? "127.0.0.1"}`
    );
    const { origin } = url;

    if (url.pathname === "/.well-known/oauth-protected-resource") {
      sendJson(response, 200, {
        resource: `${origin}/mcp`,
        authorization_servers: [origin],
        bearer_methods_supported: ["header"],
      });
      return;
    }

    if (url.pathname === "/.well-known/oauth-authorization-server") {
      sendJson(response, 200, {
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        registration_endpoint: `${origin}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      });
      return;
    }

    if (url.pathname === "/register" && request.method === "POST") {
      const body = JSON.parse(await readBody(request)) as {
        redirect_uris?: string[];
      };
      sendJson(response, 201, {
        client_id: CLIENT_ID,
        redirect_uris: body.redirect_uris ?? [REDIRECT_URL],
        token_endpoint_auth_method: "none",
        client_id_issued_at: Math.floor(Date.now() / 1000),
      });
      return;
    }

    if (url.pathname === "/authorize") {
      const redirectUri = url.searchParams.get("redirect_uri");
      const state = url.searchParams.get("state");

      if (!redirectUri || !url.searchParams.get("code_challenge")) {
        sendJson(response, 400, { error: "invalid_request" });
        return;
      }

      const target = new URL(redirectUri);
      target.searchParams.set("code", AUTHORIZATION_CODE);
      if (state) {
        target.searchParams.set("state", state);
      }
      target.searchParams.set("iss", origin);

      response.writeHead(302, { location: target.toString() });
      response.end();
      return;
    }

    if (url.pathname === "/token" && request.method === "POST") {
      const form = new URLSearchParams(await readBody(request));
      const grantType = form.get("grant_type");

      if (
        grantType === "authorization_code" &&
        form.get("code") === AUTHORIZATION_CODE
      ) {
        sendJson(response, 200, {
          access_token: ACCESS_TOKEN,
          token_type: "Bearer",
          expires_in: 3600,
          refresh_token: REFRESH_TOKEN,
        });
        return;
      }

      if (grantType === "refresh_token") {
        sendJson(response, 200, {
          access_token: ACCESS_TOKEN,
          token_type: "Bearer",
          expires_in: 3600,
          refresh_token: REFRESH_TOKEN,
        });
        return;
      }

      sendJson(response, 400, { error: "invalid_grant" });
      return;
    }

    if (url.pathname === "/mcp") {
      if (request.method !== "POST") {
        sendStatus(response, 405);
        return;
      }

      handleMcp(request, response, await readBody(request), origin);
      return;
    }

    sendStatus(response, 404);
  };

  const server = createServer((request, response) => {
    handler(request, response).catch(() => {
      sendStatus(response, 500);
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Fake authorization server did not report a port");
  }

  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}

describe("MCP 授权链路", () => {
  let fake: FakeAuthorizationServer | undefined;
  let manager: McpManager | undefined;

  afterEach(async () => {
    await manager?.close();
    manager = undefined;
    await fake?.close();
    fake = undefined;
  });

  test("401 拿到授权地址，回调换令牌，重连后列出工具", async () => {
    fake = await startFakeServer();

    const server: McpServerConfig = {
      id: "demo",
      name: "demo",
      enabled: true,
      autoApprove: false,
      auth: { type: "oauth" },
      transport: { type: "http", url: `${fake.origin}/mcp`, headers: {} },
    };

    const store = createMemoryCredentialStore();
    const flows = new McpAuthorizationFlows();
    const createAuthProvider = (target: McpServerConfig) =>
      new McpOAuthProvider({
        serverId: target.id,
        store,
        redirectUrl: REDIRECT_URL,
        onState: (state) => {
          flows.register(state, target);
        },
      });

    manager = new McpManager({ createAuthProvider, idleTimeoutMs: 10 });

    const serverUrl = `${fake.origin}/mcp`;
    const first = await manager.authorize(server);

    // 模拟浏览器：访问授权地址，跟着 302 到回调地址，拿到 code 与 state。
    const authorization = new URL(first.url!);
    const redirect = await fetch(authorization, { redirect: "manual" });
    const location = new URL(redirect.headers.get("location") ?? "");

    const code = location.searchParams.get("code");
    const state = location.searchParams.get("state");
    if (code === null || state === null) {
      throw new Error("Authorization response is missing code or state");
    }

    expect({
      status: first.status,
      callback: `${location.origin}${location.pathname}`,
      code,
      // 回环路由靠这张表把 state 换回服务器 id。
      flow: flows.take(state)?.id,
    }).toStrictEqual({
      status: "needs-auth",
      callback: REDIRECT_URL,
      code: AUTHORIZATION_CODE,
      flow: server.id,
    });

    const provider = createAuthProvider(server);
    await completeMcpAuthorization({
      provider,
      serverUrl,
      code,
      state,
      issuer: location.searchParams.get("iss") ?? undefined,
    });

    const second = await manager.authorize(server);

    const stored = await provider.tokens();

    expect({
      tokens: stored,
      // 刷新要求令牌自己带着授权服务器的 pin，否则下一次 401 只能重新授权。
      pin: stored?.token_endpoint,
      status: second.status,
      toolCount: second.toolCount,
    }).toMatchObject({
      tokens: { access_token: ACCESS_TOKEN, refresh_token: REFRESH_TOKEN },
      pin: `${fake.origin}/token`,
      status: "ready",
      toolCount: 1,
    });
  });

  test("没有授权时，不带令牌的服务器只报连接失败", async () => {
    fake = await startFakeServer();

    const server: McpServerConfig = {
      id: "plain",
      name: "plain",
      enabled: true,
      autoApprove: false,
      auth: { type: "headers" },
      transport: {
        type: "http",
        url: `${fake.origin}/mcp`,
        headers: { Authorization: "Bearer wrong" },
      },
    };

    manager = new McpManager({ idleTimeoutMs: 10 });

    const result = await manager.authorize(server);
    expect(result.status).toBe("failed");
    expect(result.url).toBeUndefined();
  });

  test("测试连接不会发起授权，也不会写下任何凭据", async () => {
    fake = await startFakeServer();

    const server: McpServerConfig = {
      id: "probe",
      name: "probe",
      enabled: true,
      autoApprove: false,
      auth: { type: "oauth" },
      transport: { type: "http", url: `${fake.origin}/mcp`, headers: {} },
    };

    const store = createMemoryCredentialStore();
    const flows = new McpAuthorizationFlows();
    const createAuthProvider = (target: McpServerConfig) =>
      new McpOAuthProvider({
        serverId: target.id,
        store,
        redirectUrl: REDIRECT_URL,
        onState: (state) => {
          flows.register(state, target);
        },
      });

    manager = new McpManager({ createAuthProvider, idleTimeoutMs: 10 });

    const result = await manager.test(server);

    // 只读令牌那一档：没有令牌就得到一次 401，而不是一次注册加一次跳转。
    expect({
      ok: result.ok,
      credentials: store.rows.size,
      flows: flows.size,
    }).toStrictEqual({ ok: false, credentials: 0, flows: 0 });
  });
});
