import { ORPCError } from "@orpc/server";
import { DEFAULT_ERROR_MESSAGE } from "@workspace/shared/errors";
import { describe, expect, expectTypeOf, test } from "vitest";

import { ApiError, errors } from "../src/errors";

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

  test("should build a common code straight from the map", () => {
    const error = errors.NOT_FOUND();

    expect(error.code).toBe("NOT_FOUND");
    expect(error.status).toBe(404);
    expect(error.message).toBe("Not Found");
  });

  test("should keep the generic message for a code that declares it", () => {
    const error = errors.MESSAGE_NOT_FOUND({ data: { sessionId: "s1" } });

    expect(error.message).toBe(DEFAULT_ERROR_MESSAGE);
  });
});

// The `@ts-expect-error` is the assertion: a payload the code's schema does not
// accept is a compile error, so this is never meant to be called.
const withAnUnknownField = () =>
  // @ts-expect-error — SESSION_NOT_FOUND declares `{ sessionId: string }`
  new ApiError("SESSION_NOT_FOUND", { data: { id: "s1" } });

describe(ApiError, () => {
  test("should derive the status from the error map", () => {
    const error = new ApiError("NOT_FOUND", { message: "Agent not found" });

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("ApiError");
    expect(error.code).toBe("NOT_FOUND");
    expect(error.status).toBe(404);
    expect(error.message).toBe("Agent not found");
  });

  test("should fall back to the message the code declares", () => {
    const error = new ApiError("BAD_REQUEST");

    expect(error.message).toBe("Bad Request");
    expect(error.status).toBe(400);
  });

  test("should type the payload from the schema the code declares", () => {
    const error = new ApiError("SESSION_NOT_FOUND", {
      data: { sessionId: "s1" },
    });

    expectTypeOf(error.data).toEqualTypeOf<{ sessionId: string } | undefined>();
    expectTypeOf(error.toORPCError().data).toEqualTypeOf<
      { sessionId: string } | undefined
    >();
  });

  test("should take the payload from a data-only options object", () => {
    const error = new ApiError("MODEL_NOT_FOUND", { data: { model: "gpt" } });

    expectTypeOf(error.data).toEqualTypeOf<{ model: string } | undefined>();
    expect(error.message).toBe("The requested AI model was not found.");
  });

  test("should fall back to an unknown payload type", () => {
    const error = new ApiError("BAD_REQUEST");

    expectTypeOf(error.data).toBeUnknown();
  });

  test("should take any payload for a code that declares no schema", () => {
    const error = new ApiError("NOT_FOUND", {
      message: "Agent not found",
      data: { agentId: "a1" },
    });

    expectTypeOf(error.data).toBeUnknown();
    expect(error.data).toStrictEqual({ agentId: "a1" });
  });

  test("should reject a payload the code's schema does not accept", () => {
    expect(withAnUnknownField).toBeTypeOf("function");
  });

  test("should convert into an ORPCError of the same code, status and data", () => {
    const error = new ApiError("NOT_FOUND", {
      message: "Agent not found",
      data: { agentId: "a1" },
    });

    const orpcError = error.toORPCError();

    expect(orpcError).toBeInstanceOf(ORPCError);
    expect(orpcError.code).toBe("NOT_FOUND");
    expect(orpcError.status).toBe(404);
    expect(orpcError.data).toStrictEqual({ agentId: "a1" });
  });
});
