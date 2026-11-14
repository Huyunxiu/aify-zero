import type { ModelRef } from "@workspace/shared/model";

import type { ModelTargetResolver } from "../../src/kernel/model-gateway.js";

/** 测试里唯一用到的模型引用；供应商固定，模型 id 按用例区分。 */
export const testModel = (modelId = "test-model"): ModelRef => ({
  providerId: "test-provider",
  modelId,
});

/** 模型解析替身：只回答一组固定的接入信息，测试不碰网络。 */
export const testResolveModel: ModelTargetResolver = (ref) => ({
  ref,
  name: "test-provider",
  protocol: "openai-chat",
  baseURL: "http://127.0.0.1:1",
  apiKey: "test-key",
});
