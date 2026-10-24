import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";

import { APP_ORIGIN } from "@workspace/shared/app-url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AppProtocolOptions } from "../src/protocol/handler";
import { createAppProtocolHandler } from "../src/protocol/handler";

const appRequest = (pathname: string, init?: RequestInit): Request =>
  new Request(`${APP_ORIGIN}${pathname}`, init);

const noopApi: AppProtocolOptions["api"] = {
  fetch: () => Promise.resolve(new Response("ok")),
  origin: () => "http://127.0.0.1:18086",
};

const startDevServer = async (payload: string) => {
  const compressed = gzipSync(payload);
  const seen: { host: string | undefined; url: string | undefined } = {
    host: undefined,
    url: undefined,
  };
  const server = createServer((request, response) => {
    seen.host = request.headers.host;
    seen.url = request.url;
    response.writeHead(200, {
      "content-encoding": "gzip",
      "content-length": String(compressed.length),
      "content-type": "text/javascript",
      "set-cookie": "session=secret",
    });
    response.end(compressed);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  return {
    close: async () =>
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
    seen,
    url: `http://127.0.0.1:${port}`,
  };
};

describe("aify-app protocol handler", () => {
  let root = "";

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "aify-protocol-"));
    await writeFile(
      path.join(root, "index.html"),
      "<!doctype html><title>app</title>"
    );
    await mkdir(path.join(root, "assets"), { recursive: true });
    await writeFile(path.join(root, "assets", "app.js"), "console.log('app')");
    await writeFile(path.join(root, "package.json"), '{"secret":true}');
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("serves the index for the document root", async () => {
    const handler = createAppProtocolHandler({
      api: noopApi,
      webRoot: root,
    });

    const response = await handler(appRequest("/"));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.text()).resolves.toContain("<title>app</title>");
  });

  it("falls back to index only for HTML navigations", async () => {
    const handler = createAppProtocolHandler({
      api: noopApi,
      webRoot: root,
    });

    const navigation = await handler(
      appRequest("/sessions/abc", { headers: { accept: "text/html" } })
    );
    expect(navigation.status).toBe(200);
    await expect(navigation.text()).resolves.toContain("<title>app</title>");

    const missingAsset = await handler(
      appRequest("/assets/missing.js", { headers: { accept: "*/*" } })
    );
    expect(missingAsset.status).toBe(404);
  });

  it("serves hashed assets with an immutable cache policy", async () => {
    const handler = createAppProtocolHandler({
      api: noopApi,
      webRoot: root,
    });

    const response = await handler(appRequest("/assets/app.js"));

    expect(response.headers.get("content-type")).toContain("text/javascript");
    expect(response.headers.get("cache-control")).toContain("immutable");
    await expect(response.text()).resolves.toBe("console.log('app')");
  });

  it("answers HEAD without a body", async () => {
    const handler = createAppProtocolHandler({
      api: noopApi,
      webRoot: root,
    });

    const response = await handler(
      appRequest("/assets/app.js", { method: "HEAD" })
    );

    expect(response.status).toBe(200);
    expect(response.body).toBeNull();
    expect(response.headers.get("content-type")).toContain("text/javascript");
  });

  it("rejects path traversal and malformed paths", async () => {
    const handler = createAppProtocolHandler({
      api: noopApi,
      webRoot: root,
    });

    const traversal = await handler(appRequest("/%2e%2e%2fpackage.json"));
    expect(traversal.status).toBe(403);

    const malformed = await handler(appRequest("/%"));
    expect(malformed.status).toBe(400);
  });

  it("does not follow symlinks out of the document root", async () => {
    const outside = await mkdtemp(path.join(tmpdir(), "aify-outside-"));
    const link = path.join(root, "linked.txt");

    try {
      await writeFile(path.join(outside, "secret.txt"), "secret");
      await symlink(path.join(outside, "secret.txt"), link);

      const handler = createAppProtocolHandler({
        api: noopApi,
        webRoot: root,
      });

      const response = await handler(appRequest("/linked.txt"));

      expect(response.status).toBe(403);
    } finally {
      await rm(link, { force: true });
      await rm(outside, { force: true, recursive: true });
    }
  });

  it("answers 404 for a directory rather than 500", async () => {
    const handler = createAppProtocolHandler({
      api: noopApi,
      webRoot: root,
    });

    const response = await handler(appRequest("/assets"));

    expect(response.status).toBe(404);
  });

  it("does not cache the SPA shell as immutable via an encoded assets path", async () => {
    const handler = createAppProtocolHandler({
      api: noopApi,
      webRoot: root,
    });

    const response = await handler(appRequest("/assets/..%2Findex.html"));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("only accepts the app host", async () => {
    const handler = createAppProtocolHandler({
      api: noopApi,
      webRoot: root,
    });

    const response = await handler(new Request("aify-app://other/"));

    expect(response.status).toBe(404);
  });

  it("forwards API requests to the configured server", async () => {
    let seen:
      | { body: string; method: string; origin: string | null; url: string }
      | undefined;
    const handler = createAppProtocolHandler({
      api: {
        fetch: async (input, init) => {
          seen = {
            body:
              init?.body === null || init?.body === undefined
                ? ""
                : await new Response(init.body).text(),
            method: init?.method ?? "GET",
            origin: new Headers(init?.headers).get("origin"),
            url:
              input instanceof URL
                ? input.href
                : typeof input === "string"
                  ? input
                  : input.url,
          };
          return new Response("ok", { status: 201 });
        },
        origin: () => "http://127.0.0.1:18086",
      },
      webRoot: root,
    });

    const response = await handler(
      appRequest("/api/rpc/agent/list?x=1", {
        body: "hello",
        headers: { origin: APP_ORIGIN },
        method: "POST",
      })
    );

    expect(response.status).toBe(201);
    expect(seen).toMatchObject({
      body: "hello",
      method: "POST",
      origin: null,
      url: "http://127.0.0.1:18086/api/rpc/agent/list?x=1",
    });
  });

  it("injects the server token and drops a renderer Authorization header", async () => {
    let authorization: string | null = null;
    const handler = createAppProtocolHandler({
      api: {
        fetch: (_input, init) => {
          authorization = new Headers(init?.headers).get("authorization");
          return Promise.resolve(new Response("ok"));
        },
        origin: () => "http://127.0.0.1:18086",
        token: "server-token",
      },
      webRoot: root,
    });

    const response = await handler(
      appRequest("/api/rpc/agent/list", {
        body: "{}",
        headers: { authorization: "Bearer renderer-token" },
        method: "POST",
      })
    );

    expect(response.status).toBe(200);
    expect(authorization).toBe("Bearer server-token");
  });

  it("answers 503 while no API server is attached", async () => {
    const handler = createAppProtocolHandler({
      api: { origin: () => {} },
      webRoot: root,
    });

    const response = await handler(
      appRequest("/api/rpc/agent/list", { body: "hello", method: "POST" })
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("1");
    await expect(response.json()).resolves.toMatchObject({
      code: "SERVER_UNAVAILABLE",
    });
  });

  it("waits for the server before forwarding the first request", async () => {
    let resolveOrigin: ((origin: string) => void) | undefined;
    const originPromise = new Promise<string>((resolve) => {
      resolveOrigin = resolve;
    });

    const handler = createAppProtocolHandler({
      api: {
        fetch: () => Promise.resolve(new Response("ready", { status: 200 })),
        origin: () => {},
        waitForOrigin: async () => await originPromise,
      },
      webRoot: root,
    });

    const pending = handler(
      appRequest("/api/rpc/agent/list", { body: "hello", method: "POST" })
    );

    resolveOrigin?.("http://127.0.0.1:18086");

    const response = await pending;

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("ready");
  });

  it("rejects API requests from a foreign origin", async () => {
    let calls = 0;
    const handler = createAppProtocolHandler({
      api: {
        fetch: () => {
          calls += 1;
          return Promise.resolve(new Response("ok"));
        },
        origin: () => "http://127.0.0.1:18086",
      },
      webRoot: root,
    });

    const response = await handler(
      appRequest("/api/rpc/agent/list", {
        body: "hello",
        headers: { origin: "https://evil.example" },
        method: "POST",
      })
    );

    expect(response.status).toBe(403);
    expect(calls).toBe(0);
  });

  it("proxies document requests to the dev server", async () => {
    const dev = await startDevServer("console.log('vite')");

    try {
      const handler = createAppProtocolHandler({
        api: noopApi,
        devServerUrl: dev.url,
      });

      await handler(
        appRequest("/@vite/client", { headers: { host: "aify-app" } })
      );

      expect(dev.seen.url).toBe("/@vite/client");
      expect(dev.seen.host).toBe(new URL(dev.url).host);
    } finally {
      await dev.close();
    }
  });

  it("strips body-level headers from dev server responses", async () => {
    const payload = "console.log('vite')";
    const dev = await startDevServer(payload);

    try {
      const handler = createAppProtocolHandler({
        api: noopApi,
        devServerUrl: dev.url,
      });

      const response = await handler(appRequest("/@vite/client"));

      expect(response.headers.get("content-encoding")).toBeNull();
      expect(response.headers.get("content-length")).toBeNull();
      expect(response.headers.get("set-cookie")).toBeNull();
      await expect(response.text()).resolves.toBe(payload);
    } finally {
      await dev.close();
    }
  });
});
