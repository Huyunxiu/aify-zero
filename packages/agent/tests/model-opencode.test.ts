import { describe, expect, test } from "vitest";

import {
  isOpencodeURL,
  opencodeHeaders,
  withOpencodeHeaders,
} from "../src/model/opencode";

describe("OpenCode 网关请求头", () => {
  test("opencode.ai 及其子域才算它的网关", () => {
    expect(isOpencodeURL("https://opencode.ai/zen/v1")).toBeTruthy();
    expect(isOpencodeURL("https://api.opencode.ai/v1")).toBeTruthy();
    expect(isOpencodeURL("https://notopencode.ai/v1")).toBeFalsy();
    expect(isOpencodeURL("https://opencode.ai.evil.dev/v1")).toBeFalsy();
    expect(isOpencodeURL("not a url")).toBeFalsy();
  });

  test("会话头四个一起发，缺一个都会被网关拒绝", () => {
    const headers = opencodeHeaders({
      baseURL: "https://opencode.ai/zen/go/v1",
      sessionId: "session-1",
      projectDir: "/tmp/project",
    });

    // 四个会话头必须同值：网关按它们路由，缺一个都会被拒绝。
    expect([
      headers["x-opencode-session"],
      headers["x-opencode-session-id"],
      headers["x-session-affinity"],
      headers["x-session-id"],
    ]).toStrictEqual(["session-1", "session-1", "session-1", "session-1"]);
    expect(headers["x-opencode-client"]).toBe("cli");
    expect(headers["x-opencode-project"]).toBe("/tmp/project");
    expect(headers["User-Agent"]).toContain("opencode/");
  });

  test("别的地址一个头都不加", () => {
    expect(
      opencodeHeaders({
        baseURL: "https://api.deepseek.com/v1",
        sessionId: "s",
      })
    ).toStrictEqual({});
  });
});

describe("请求头优先级", () => {
  test("用户配置覆盖网关默认头", () => {
    const headers = withOpencodeHeaders({
      baseURL: "https://opencode.ai/zen/v1",
      sessionId: "session-1",
      headers: { "User-Agent": "custom/1.0", "X-Trace": "on" },
    });

    expect(headers["User-Agent"]).toBe("custom/1.0");
    expect(headers["X-Trace"]).toBe("on");
    // 用户没覆盖的默认头仍然在。
    expect(headers["x-opencode-client"]).toBe("cli");
  });

  test("默认头是起点，不是终点", () => {
    const headers = withOpencodeHeaders({
      baseURL: "https://opencode.ai/zen/v1",
      sessionId: "session-1",
      headers: { "x-opencode-session": "pinned" },
    });

    expect(headers["x-opencode-session"]).toBe("pinned");
  });
});
