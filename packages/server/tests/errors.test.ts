import { ORPCError } from "@orpc/server";
import { DEFAULT_ERROR_MESSAGE } from "@workspace/shared/errors";
import { describe, expect, expectTypeOf, test } from "vitest";

import {
  commonErrors,
  errors,
  getErrorCause,
  normalizeError,
} from "../src/errors";

describe("errors factory map", () => {
  test("should build an error carrying its declared status and default message", () => {
    const error = errors.MODEL_NOT_FOUND({ data: { model: "gpt" } });

    expect(error.code).toBe("MODEL_NOT_FOUND");
    expect(error.status).toBe(400);
    expect(error.message).toBe("The requested AI model was not found.");
    expect(error.data).toStrictEqual({ model: "gpt" });
  });

  test("should allow overriding the message", () => {
    const error = errors.NOTHING_TO_FORK({ message: "custom" });

    expect(error.message).toBe("custom");
  });

  test("should type the data payload", () => {
    const error = errors.SESSION_NOT_FOUND({ data: { sessionId: "s1" } });

    expectTypeOf(error.data.sessionId).toEqualTypeOf<string>();
  });
});

describe("commonErrors handle", () => {
  test("should build a plain ORPCError for common codes", () => {
    const error = commonErrors.notFound("Agent not found");

    expect(error).toBeInstanceOf(ORPCError);
    expect(error.code).toBe("NOT_FOUND");
    expect(error.message).toBe("Agent not found");
  });

  test("should never leak the cause into a generic internal error", () => {
    const error = commonErrors.internal(new Error("secret"), "req-1");

    expect(error.message).toBe(DEFAULT_ERROR_MESSAGE);
    expect(error.data).toStrictEqual({ requestId: "req-1" });
    expect(getErrorCause(error)).toBeInstanceOf(Error);
  });
});

describe(normalizeError, () => {
  test("should pass an existing ORPCError through untouched", () => {
    const thrown = errors.NOTHING_TO_FORK();

    expect(normalizeError(thrown)).toBe(thrown);
  });

  test("should mask an unexpected error behind a generic internal error", () => {
    const normalized = normalizeError(new Error("boom"), "req-2");

    expect(normalized.code).toBe("INTERNAL_SERVER_ERROR");
    expect(normalized.message).toBe(DEFAULT_ERROR_MESSAGE);
    expect(normalized.message).not.toContain("boom");
    expect(getErrorCause(normalized)).toBeInstanceOf(Error);
  });

  test("should not serialize the cause onto the wire", () => {
    const normalized = normalizeError(new Error("boom"));

    expect(normalized.toJSON()).not.toHaveProperty("cause");
    expect(JSON.stringify(normalized.toJSON())).not.toContain("boom");
  });
});
