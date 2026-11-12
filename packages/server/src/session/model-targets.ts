import type { ModelTargetResolver } from "@workspace/agent";

import type { UserSettings } from "../routers/settings/settings.schema";

/**
 * 把一份设置变成网关能用的解析函数。
 *
 * 解析在每次调用时进行：运行中的补丁可以把模型换到另一家供应商，地址、协议
 * 和密钥都要跟着换。
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
      apiKey: provider.apiKey,
      ...(provider.headers ? { headers: provider.headers } : {}),
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
