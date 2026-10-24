import { describe, expect, it } from "vitest";

import {
  formatOrigin,
  normalizeApiHost,
  resolveApiEndpoint,
} from "../src/api-endpoint";

describe(resolveApiEndpoint, () => {
  it("defaults to loopback and the default port", () => {
    const endpoint = resolveApiEndpoint({ env: {} });

    expect(endpoint).toStrictEqual({
      connectHost: "127.0.0.1",
      host: "127.0.0.1",
      origin: "http://127.0.0.1:18086",
      port: 18_086,
      portExplicit: false,
    });
  });

  it("follows AIFY_API_HOST and AIFY_API_PORT", () => {
    const endpoint = resolveApiEndpoint({
      env: { AIFY_API_HOST: "192.168.1.5", AIFY_API_PORT: "19000" },
    });

    expect(endpoint.host).toBe("192.168.1.5");
    expect(endpoint.port).toBe(19_000);
    expect(endpoint.portExplicit).toBeTruthy();
    expect(endpoint.origin).toBe("http://192.168.1.5:19000");
  });

  it("normalizes localhost to the IPv4 loopback", () => {
    const endpoint = resolveApiEndpoint({
      env: { AIFY_API_HOST: "localhost" },
    });

    expect(endpoint.host).toBe("127.0.0.1");
    expect(endpoint.connectHost).toBe("127.0.0.1");
  });

  it("brackets an IPv6 literal in the origin but not in the bind host", () => {
    const endpoint = resolveApiEndpoint({
      env: { AIFY_API_HOST: "[::1]", AIFY_API_PORT: "19000" },
    });

    expect(endpoint.host).toBe("::1");
    expect(endpoint.origin).toBe("http://[::1]:19000");
  });

  it("maps wildcard binds to a loopback client address", () => {
    expect(
      resolveApiEndpoint({ env: { AIFY_API_HOST: "0.0.0.0" } }).origin
    ).toBe("http://127.0.0.1:18086");
    expect(resolveApiEndpoint({ env: { AIFY_API_HOST: "::" } }).origin).toBe(
      "http://[::1]:18086"
    );
  });

  it("has no fixed origin when the port is OS-assigned", () => {
    const endpoint = resolveApiEndpoint({ env: { AIFY_API_PORT: "0" } });

    expect(endpoint.port).toBe(0);
    expect(endpoint.portExplicit).toBeTruthy();
    expect(endpoint.origin).toBeUndefined();
  });

  it("rejects an invalid port", () => {
    expect(() =>
      resolveApiEndpoint({ env: { AIFY_API_PORT: "not-a-port" } })
    ).toThrow(/AIFY_API_PORT/);
  });
});

describe(formatOrigin, () => {
  it("adds brackets only for IPv6", () => {
    expect(formatOrigin("127.0.0.1", 1)).toBe("http://127.0.0.1:1");
    expect(formatOrigin("::1", 1)).toBe("http://[::1]:1");
    expect(formatOrigin("[::1]", 1)).toBe("http://[::1]:1");
  });
});

describe(normalizeApiHost, () => {
  it("strips brackets and folds localhost", () => {
    expect(normalizeApiHost("[::1]")).toBe("::1");
    expect(normalizeApiHost("LOCALHOST")).toBe("127.0.0.1");
    expect(normalizeApiHost(" example.com ")).toBe("example.com");
  });
});
