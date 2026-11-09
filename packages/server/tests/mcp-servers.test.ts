import type { McpServerConfig } from "@workspace/agent";
import { describe, expect, test } from "vitest";

import { ApiError } from "../src/errors";
import { assertUniqueMcpServers } from "../src/mcp/validate";

const alpha: McpServerConfig = {
  id: "a",
  name: "alpha",
  enabled: true,
  autoApprove: false,
  transport: { type: "http", url: "https://example.com/mcp", headers: {} },
};

/** 拿到抛出的错误本身，方便断言它的载荷。 */
function captureError(run: () => void): unknown {
  try {
    run();
    return undefined;
  } catch (error) {
    return error;
  }
}

describe(assertUniqueMcpServers, () => {
  test("accepts a list without duplicates", () => {
    expect(() =>
      assertUniqueMcpServers([alpha, { ...alpha, id: "b", name: "beta" }])
    ).not.toThrow();
  });

  test("rejects a duplicate name and names the offender", () => {
    const error = captureError(() =>
      assertUniqueMcpServers([alpha, { ...alpha, id: "b" }])
    );

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("MCP_SERVER_DUPLICATE");
    expect((error as ApiError).status).toBe(409);
    expect((error as ApiError).data).toStrictEqual({
      kind: "duplicate-name",
      value: "alpha",
    });
  });

  test("rejects a duplicate id", () => {
    const error = captureError(() =>
      assertUniqueMcpServers([alpha, { ...alpha, name: "beta" }])
    );

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).data).toStrictEqual({
      kind: "duplicate-id",
      value: "a",
    });
  });
});
