import { describe, expect, expectTypeOf, test } from "vitest";

import { DEFAULT_ERROR_MESSAGE, ERROR_STATUS, parseError } from "../src/errors";

describe(parseError, () => {
  test("should keep code, status and data from an ORPCError-shaped object", () => {
    const parsed = parseError({
      defined: true,
      code: "MODEL_NOT_FOUND",
      status: 400,
      message: "The requested AI model was not found.",
      data: { model: "gpt" },
    });

    expect(parsed).toStrictEqual({
      code: "MODEL_NOT_FOUND",
      status: 400,
      message: "The requested AI model was not found.",
      data: { model: "gpt" },
    });
  });

  test("should fall back to INTERNAL_SERVER_ERROR for a plain Error", () => {
    const parsed = parseError(new Error("Failed to fetch"));

    expect(parsed).toStrictEqual({
      code: "INTERNAL_SERVER_ERROR",
      message: "Failed to fetch",
    });
  });

  test("should fall back to the default message for an unknown value", () => {
    const parsed = parseError(42);

    expect(parsed).toStrictEqual({
      code: "INTERNAL_SERVER_ERROR",
      message: DEFAULT_ERROR_MESSAGE,
    });
  });

  test("should use the provided fallback message", () => {
    expect(parseError(42, { fallbackMessage: "custom" }).message).toBe(
      "custom"
    );
  });

  test("should expose a NormalizedError shape", () => {
    const parsed = parseError(new Error("x"));

    expectTypeOf(parsed.code).toEqualTypeOf<string>();
    expectTypeOf(parsed.message).toEqualTypeOf<string>();
    expectTypeOf(parsed.status).toEqualTypeOf<number | undefined>();
  });
});

describe("error code metadata", () => {
  test("should carry an HTTP status for every code", () => {
    expect(ERROR_STATUS.MODEL_NOT_FOUND).toBe(400);
    expect(ERROR_STATUS.SESSION_NOT_FOUND).toBe(404);
  });
});
