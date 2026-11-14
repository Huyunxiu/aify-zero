import { afterEach, describe, expect, test, vi } from "vitest";

import { fetchModelList } from "../src/routers/settings/model-list";

function respond(payload: unknown): Promise<Response> {
  return Promise.resolve(Response.json(payload));
}

describe("供应商模型列表", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("读 OpenRouter 的 data 形状", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        respond({
          data: [
            {
              id: "vendor/model",
              name: "Vendor Model",
              context_length: 200_000,
              architecture: {
                input_modalities: ["text", "image"],
                output_modalities: ["text"],
              },
              top_provider: { context_length: 200_000 },
            },
          ],
        })
      )
    );

    await expect(
      fetchModelList({ baseURL: "https://openrouter.ai/api/v1", apiKey: "k" })
    ).resolves.toStrictEqual([
      {
        id: "vendor/model",
        name: "Vendor Model",
        context: 200_000,
        input: ["text", "image"],
        output: ["text"],
      },
    ]);
  });

  test("读 OpenCode 的 limit 和 MIME 模态", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        respond({
          object: "list",
          data: [
            {
              id: "glm-5.3-flash",
              name: "GLM 5.3 Flash",
              limit: { context: 1_000_000 },
              modalities: {
                input: [
                  "text",
                  "image/jpeg",
                  "image/png",
                  "audio/wav",
                  "video/mp4",
                  "application/pdf",
                ],
                output: ["text"],
              },
            },
          ],
        })
      )
    );

    await expect(
      fetchModelList({ baseURL: "https://opencode.ai/zen/go/v1", apiKey: "k" })
    ).resolves.toStrictEqual([
      {
        id: "glm-5.3-flash",
        name: "GLM 5.3 Flash",
        context: 1_000_000,
        input: ["text", "image", "audio", "video", "pdf"],
        output: ["text"],
      },
    ]);
  });

  test("顶层数组和 model 字段也能读", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        respond([
          { model: "b-model", display_name: "B Model" },
          { name: "a-model" },
        ])
      )
    );

    await expect(
      fetchModelList({ baseURL: "https://gateway.test/v1", apiKey: "k" })
    ).resolves.toStrictEqual([
      { id: "a-model", name: "a-model" },
      { id: "b-model", name: "B Model" },
    ]);
  });
});
