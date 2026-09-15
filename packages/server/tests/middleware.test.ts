import { call, ORPCError } from "@orpc/server";
import { DEFAULT_ERROR_MESSAGE } from "@workspace/shared/errors";
import { logger } from "@workspace/shared/logger";
import { describe, expect, test } from "vitest";

import { ApiError } from "../src/errors";
import { apiErrorMiddleware, o, publicProcedure } from "../src/index";

const context = { requestId: "req-test", logger };

describe("apiErrorMiddleware translation", () => {
  test("should convert an ApiError thrown by the handler", async () => {
    const procedure = o.use(apiErrorMiddleware).handler(() => {
      throw new ApiError("NOT_FOUND", "Agent not found", {
        data: { agentId: "a1" },
      });
    });

    const called = call(procedure, undefined, { context });

    await expect(called).rejects.toBeInstanceOf(ORPCError);
    await expect(called).rejects.toMatchObject({
      code: "NOT_FOUND",
      status: 404,
      message: "Agent not found",
      data: { agentId: "a1" },
    });
  });

  test("should rethrow anything that is not an ApiError", async () => {
    const procedure = o.use(apiErrorMiddleware).handler(() => {
      throw new Error("boom");
    });

    const called = call(procedure, undefined, { context });

    await expect(called).rejects.not.toBeInstanceOf(ORPCError);
    await expect(called).rejects.toThrow("boom");
  });
});

describe("publicProcedure pipeline", () => {
  test("should hand an ApiError to the client untouched by the normalizer", async () => {
    const procedure = publicProcedure.handler(() => {
      throw new ApiError("NOT_FOUND", "Agent not found");
    });

    const called = call(procedure, undefined, { context });

    await expect(called).rejects.toBeInstanceOf(ORPCError);
    await expect(called).rejects.toMatchObject({
      code: "NOT_FOUND",
      status: 404,
      message: "Agent not found",
    });
  });

  test("should mask an unexpected error behind a generic internal error", async () => {
    const procedure = publicProcedure.handler(() => {
      throw new Error("boom");
    });

    await expect(call(procedure, undefined, { context })).rejects.toMatchObject(
      {
        code: "INTERNAL_SERVER_ERROR",
        message: DEFAULT_ERROR_MESSAGE,
      }
    );
  });
});
