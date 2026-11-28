import { TEXT_ONLY_INPUT_KINDS } from "@workspace/agent";
import type { ModelTargetResolver } from "@workspace/agent";

import { providerKey } from "../routers/settings/provider-key";
import type { UserSettings } from "../routers/settings/settings.schema";

/**
 * 把一份设置变成网关能用的解析函数。
 *
 * 解析在每次调用时进行：运行中的补丁可以把模型换到另一家供应商，地址、协议
 * 和密钥都要跟着换。
 *
 * The key may live in the process environment, so this reads the resolved value rather
 * than the field on the row. Nothing caches it: two calls in one run can see two values.
 */
export function createModelTargetResolver(
  settings: UserSettings
): ModelTargetResolver {
  const providers = new Map(
    settings.providers.map((provider) => [provider.id, provider])
  );

  return (ref) => {
    const provider = providers.get(ref.providerId);
    if (!provider?.active) {
      return;
    }
    const model = provider.models.find((entry) => entry.id === ref.modelId);
    // 关掉的模型同样调不到：补丁解析也走这里，不能只靠入口那一处校验。
    if (!model?.active) {
      return;
    }
    return {
      ref,
      name: provider.id,
      protocol: provider.protocol,
      baseURL: provider.baseURL,
      apiKey: providerKey(provider),
      ...(provider.headers ? { headers: provider.headers } : {}),
      // An unconfigured route declares nothing, and nothing means text only: an
      // image must not reach a route that never said it reads one.
      inputKinds: model.modalities?.input ?? TEXT_ONLY_INPUT_KINDS,
    };
  };
}

/** 供应商 id → 模型 id → 上下文窗口。 */
export function modelContextWindows(
  settings: UserSettings
): Record<string, Record<string, number>> {
  return Object.fromEntries(
    settings.providers.map((provider) => [
      provider.id,
      Object.fromEntries(
        provider.models
          .filter((model) => (model.limit?.context ?? 0) > 0)
          .map((model) => [model.id, model.limit?.context ?? 0])
      ),
    ])
  );
}
