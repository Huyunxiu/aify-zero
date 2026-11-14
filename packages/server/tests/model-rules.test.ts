import type { AgentUserTurn } from "@workspace/agent-client";
import { ModelEffort } from "@workspace/shared/constants";
import { describe, expect, test } from "vitest";

import type { ConfiguredModel } from "../src/routers/settings/settings.schema";
import {
  acceptedEffort,
  unsupportedInput,
  unsupportedInputIn,
} from "../src/session/model-rules";

function configured(
  input: readonly ("text" | "image" | "audio" | "video" | "pdf")[]
): ConfiguredModel {
  return {
    ref: { providerId: "test", modelId: "test-model" },
    provider: {
      id: "test",
      name: "Test",
      protocol: "openai-chat",
      baseURL: "https://example.test/v1",
      apiKey: "",
      active: true,
      models: [],
    },
    model: {
      id: "test-model",
      name: "Test",
      active: true,
      modalities: { input: [...input], output: ["text"] },
      limit: { context: 128_000 },
    },
  };
}

function userTurn(mediaType?: string): AgentUserTurn {
  return {
    id: "turn-1",
    type: "user",
    createdAt: 0,
    status: "done",
    content: [
      {
        id: "step-1",
        type: "user",
        createdAt: 0,
        status: "done",
        content: [
          ...(mediaType
            ? [{ type: "file" as const, mediaType, url: "data:x" }]
            : []),
          { type: "text", text: "hi", createdAt: 0 },
        ],
      },
    ],
  };
}

describe("模型输入校验", () => {
  test("图片发给只看文本的模型会被拦下", () => {
    expect(unsupportedInput(configured(["text"]), userTurn("image/png"))).toBe(
      "image"
    );
  });

  test("模型接受图片时放行", () => {
    expect(
      unsupportedInput(configured(["text", "image"]), userTurn("image/png"))
    ).toBeUndefined();
  });

  test("纯文本不校验", () => {
    expect(unsupportedInput(configured(["text"]), userTurn())).toBeUndefined();
  });
});

describe("推理档位", () => {
  test("不支持推理的模型忽略档位", () => {
    const model = configured(["text"]);
    model.model.reasoning = false;
    expect(acceptedEffort(model, ModelEffort.Ultra)).toBeUndefined();
  });

  test("支持推理的模型照原样接收档位", () => {
    const model = configured(["text"]);
    model.model.reasoning = true;
    expect(acceptedEffort(model, ModelEffort.High)).toBe(ModelEffort.High);
  });

  test("没声明 reasoning 的模型按支持处理", () => {
    const model = configured(["text"]);
    expect(acceptedEffort(model, ModelEffort.Low)).toBe(ModelEffort.Low);
  });
});

describe("整段历史校验", () => {
  test("附件出现在更早的回合也会被拦下", () => {
    const turns = [userTurn("image/png"), userTurn()];

    expect(unsupportedInputIn(configured(["text"]), turns)).toBe("image");
  });

  test("整段历史都没有附件时放行", () => {
    const turns = [userTurn(), userTurn()];

    expect(unsupportedInputIn(configured(["text"]), turns)).toBeUndefined();
  });

  test("更早的回合有附件、模型接受图片时放行", () => {
    const turns = [userTurn("image/png")];

    expect(
      unsupportedInputIn(configured(["text", "image"]), turns)
    ).toBeUndefined();
  });
});
