import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import {
  defaultServerOrigin,
  isLoopbackOrigin,
  isServerHealthy,
  normalizeServerOrigin,
} from "../src/server-origin";

describe("server origin", () => {
  const originalHost = process.env.AIFY_API_HOST;
  const originalPort = process.env.AIFY_API_PORT;

  afterEach(() => {
    if (originalHost === undefined) {
      delete process.env.AIFY_API_HOST;
    } else {
      process.env.AIFY_API_HOST = originalHost;
    }
    if (originalPort === undefined) {
      delete process.env.AIFY_API_PORT;
    } else {
      process.env.AIFY_API_PORT = originalPort;
    }
  });

  describe("default server origin", () => {
    it("defaults to the loopback API port", () => {
      delete process.env.AIFY_API_HOST;
      delete process.env.AIFY_API_PORT;

      expect(defaultServerOrigin()).toBe("http://127.0.0.1:18086");
    });

    it("follows AIFY_API_HOST and AIFY_API_PORT", () => {
      process.env.AIFY_API_HOST = "192.168.1.5";
      process.env.AIFY_API_PORT = "19000";

      expect(defaultServerOrigin()).toBe("http://192.168.1.5:19000");
    });

    it("brackets an IPv6 literal", () => {
      process.env.AIFY_API_HOST = "::1";
      process.env.AIFY_API_PORT = "19000";

      expect(defaultServerOrigin()).toBe("http://[::1]:19000");
    });

    it("normalizes localhost and wildcard binds to a loopback origin", () => {
      process.env.AIFY_API_HOST = "localhost";
      expect(defaultServerOrigin()).toBe("http://127.0.0.1:18086");

      process.env.AIFY_API_HOST = "0.0.0.0";
      expect(defaultServerOrigin()).toBe("http://127.0.0.1:18086");

      process.env.AIFY_API_HOST = "::";
      expect(defaultServerOrigin()).toBe("http://[::1]:18086");
    });

    it("has no probe target when the port is OS-assigned", () => {
      process.env.AIFY_API_PORT = "0";

      expect(defaultServerOrigin()).toBeUndefined();
    });

    it("rejects an invalid port before anything listens", () => {
      process.env.AIFY_API_PORT = "not-a-port";

      expect(() => defaultServerOrigin()).toThrow(/AIFY_API_PORT/);
    });
  });

  describe("normalizing an origin", () => {
    it("keeps only the origin", () => {
      expect(normalizeServerOrigin("http://127.0.0.1:18086/api/rpc?x=1")).toBe(
        "http://127.0.0.1:18086"
      );
    });

    it("rejects non-http schemes", () => {
      expect(() => normalizeServerOrigin("ftp://127.0.0.1:18086")).toThrow(
        /http\(s\)/
      );
    });

    it("rejects embedded credentials", () => {
      expect(() =>
        normalizeServerOrigin("http://user:secret@127.0.0.1:18086")
      ).toThrow(/credentials/);
    });
  });

  describe("loopback detection", () => {
    it("accepts IPv4, IPv6 and localhost", () => {
      expect(isLoopbackOrigin("http://127.0.0.1:18086")).toBeTruthy();
      expect(isLoopbackOrigin("http://[::1]:18086")).toBeTruthy();
      expect(isLoopbackOrigin("http://localhost:18086")).toBeTruthy();
      expect(isLoopbackOrigin("http://app.localhost:18086")).toBeTruthy();
    });

    it("rejects anything else", () => {
      expect(isLoopbackOrigin("http://192.168.1.5:18086")).toBeFalsy();
      expect(isLoopbackOrigin("https://example.com")).toBeFalsy();
      expect(isLoopbackOrigin("http://0.0.0.0:18086")).toBeFalsy();
    });
  });

  describe("health probe", () => {
    it("sends the bearer token and requires ok:true", async () => {
      let authorization: string | undefined;
      const server = createServer((request, response) => {
        ({ authorization } = request.headers);
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ ok: true }));
      });

      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", resolve);
      });
      const { port } = server.address() as AddressInfo;

      try {
        await expect(
          isServerHealthy(`http://127.0.0.1:${port}`, "secret")
        ).resolves.toBeTruthy();
        expect(authorization).toBe("Bearer secret");
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
        });
      }
    });
  });
});
