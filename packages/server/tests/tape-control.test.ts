import { createServer } from "node:http";

import { afterEach, describe, expect, test } from "vitest";

import { notifyTapeTakeover } from "../src/session/tape-control";

const original = process.env.AIFY_TAPE_CONTROL;

/** 轮询一个状态，直到它成立。 */
const waitFor = async (check: () => boolean): Promise<void> => {
  const deadline = Date.now() + 2000;

  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error("timed out waiting for the condition");
    }

    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });
  }
};

describe("tape control", () => {
  afterEach(() => {
    if (original === undefined) {
      delete process.env.AIFY_TAPE_CONTROL;
    } else {
      process.env.AIFY_TAPE_CONTROL = original;
    }
  });

  test("posts a takeover when a control endpoint is configured", async () => {
    const calls: string[] = [];
    const server = createServer((request, response) => {
      calls.push(`${request.method ?? ""} ${request.url ?? ""}`);
      response.writeHead(204);
      response.end();
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });

    try {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      process.env.AIFY_TAPE_CONTROL = `http://127.0.0.1:${port}`;

      notifyTapeTakeover();
      await waitFor(() => calls.length === 1);

      expect(calls).toStrictEqual(["POST /__tape/takeover"]);
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });

  test("does nothing when the variable is unset", () => {
    delete process.env.AIFY_TAPE_CONTROL;

    expect(() => {
      notifyTapeTakeover();
    }).not.toThrow();
  });
});
