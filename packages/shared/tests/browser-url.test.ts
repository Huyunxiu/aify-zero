import { describe, expect, test } from "vitest";

import { parseBrowserUrlRejection } from "../src/browser-protocol";
import { resolveBrowserUrl } from "../src/browser-url";

/** 只关心拒绝原因。 */
function rejectionOf(input: string, apiOrigin?: string) {
  const result = resolveBrowserUrl(input, { apiOrigin });

  return result.ok ? null : result.reason;
}

/** 只关心放行后的地址。 */
function urlOf(input: string, apiOrigin?: string) {
  const result = resolveBrowserUrl(input, { apiOrigin });

  return result.ok ? result.url : null;
}

describe("browser URL policy", () => {
  test("accepts http and https", () => {
    expect(urlOf("https://example.com/docs")).toBe("https://example.com/docs");
    expect(urlOf("http://example.com/")).toBe("http://example.com/");
  });

  test("adds https to a bare host", () => {
    expect(urlOf("example.com")).toBe("https://example.com/");
    expect(urlOf("  example.com/a?b=1  ")).toBe("https://example.com/a?b=1");
  });

  test("keeps a host with a port as a host, not a scheme", () => {
    expect(urlOf("localhost:3000")).toBe("https://localhost:3000/");
    expect(urlOf("example.com:8080/a")).toBe("https://example.com:8080/a");
    expect(urlOf("[::1]:3000")).toBe("https://[::1]:3000/");
  });

  test("rejects non-http schemes", () => {
    expect(rejectionOf("ftp://example.com")).toBe("scheme");
    expect(rejectionOf("file:///etc/passwd")).toBe("scheme");
    expect(rejectionOf("data:text/html,hi")).toBe("scheme");
    expect(rejectionOf(["java", "script:alert(1)"].join(""))).toBe("scheme");
    expect(rejectionOf("aify-app://app/")).toBe("scheme");
  });

  test("rejects URLs that carry credentials", () => {
    expect(rejectionOf("https://user:secret@example.com")).toBe("credentials");
    expect(rejectionOf("http://user@example.com")).toBe("credentials");
  });

  test("rejects empty and unparseable input", () => {
    expect(rejectionOf("")).toBe("empty");
    expect(rejectionOf("   ")).toBe("empty");
    expect(rejectionOf("http://")).toBe("invalid");
  });

  test("rejects the app API origin", () => {
    expect(
      rejectionOf("http://127.0.0.1:18086/api/ws", "http://127.0.0.1:18086")
    ).toBe("app-origin");
  });

  test("rejects any loopback host on the API port", () => {
    const apiOrigin = "http://127.0.0.1:18086";

    expect(rejectionOf("http://localhost:18086/", apiOrigin)).toBe(
      "loopback-port"
    );
    expect(rejectionOf("http://[::1]:18086/", apiOrigin)).toBe("loopback-port");
    expect(rejectionOf("https://127.0.0.1:18086/", apiOrigin)).toBe(
      "loopback-port"
    );
  });

  test("allows loopback on another port", () => {
    const apiOrigin = "http://127.0.0.1:18086";

    expect(urlOf("http://localhost:3000/", apiOrigin)).toBe(
      "http://localhost:3000/"
    );
    expect(urlOf("http://127.0.0.1:5173/", apiOrigin)).toBe(
      "http://127.0.0.1:5173/"
    );
  });

  test("allows a remote host on the API port", () => {
    expect(urlOf("https://example.com:18086/", "http://127.0.0.1:18086")).toBe(
      "https://example.com:18086/"
    );
  });

  test("allows loopback when no API origin is known", () => {
    expect(urlOf("http://127.0.0.1:18086/")).toBe("http://127.0.0.1:18086/");
  });
});

describe("browser URL rejection messages", () => {
  test("reads the reason through the IPC error wrapper", () => {
    expect(
      parseBrowserUrlRejection(
        "Error invoking remote method 'browser-navigate': Error: browser-url:scheme"
      )
    ).toBe("scheme");
    expect(parseBrowserUrlRejection("browser-url:credentials")).toBe(
      "credentials"
    );
  });

  test("ignores other errors", () => {
    expect(parseBrowserUrlRejection("net::ERR_NAME_NOT_RESOLVED")).toBeNull();
    expect(parseBrowserUrlRejection("browser-url:not-a-reason")).toBeNull();
  });
});
