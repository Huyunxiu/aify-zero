import type { ModelRef } from "@workspace/shared/model";

/** 设置里的供应商，只取选择器和会话用得到的字段。 */
export interface ProviderLike {
  id: string;
  name: string;
  active: boolean;
  models: readonly {
    id: string;
    name: string;
    active: boolean;
    reasoning?: boolean;
    modalities?: { input: readonly string[]; output: readonly string[] };
    limit?: { context: number };
  }[];
}

/** 选择器的一项：模型加它所属的供应商。 */
export interface ModelOption {
  ref: ModelRef;
  name: string;
  providerId: string;
  providerName: string;
  reasoning: boolean;
  acceptsImage: boolean;
  context?: number;
}

/**
 * 把供应商拍平成模型列表。
 *
 * 关掉的供应商和关掉的模型都不出现：它们在设置页存在，但不能被选中。
 */
export function flattenModels(
  providers: readonly ProviderLike[]
): ModelOption[] {
  const options: ModelOption[] = [];
  for (const provider of providers) {
    if (!provider.active) {
      continue;
    }
    for (const model of provider.models) {
      if (!model.active) {
        continue;
      }
      options.push({
        ref: { providerId: provider.id, modelId: model.id },
        name: model.name,
        providerId: provider.id,
        providerName: provider.name,
        reasoning: model.reasoning ?? true,
        acceptsImage: model.modalities?.input.includes("image") ?? true,
        ...(model.limit?.context === undefined
          ? {}
          : { context: model.limit.context }),
      });
    }
  }
  return options;
}

/** 两个引用是否指向同一个模型。 */
export function sameModel(
  left: ModelRef | undefined,
  right: ModelRef | undefined
): boolean {
  return (
    left !== undefined &&
    right !== undefined &&
    left.providerId === right.providerId &&
    left.modelId === right.modelId
  );
}

/** 从任意值里读出一个模型引用；不是引用就返回 undefined。 */
export function readModelRef(value: unknown): ModelRef | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Partial<ModelRef>;
  return typeof record.providerId === "string" &&
    typeof record.modelId === "string"
    ? { providerId: record.providerId, modelId: record.modelId }
    : undefined;
}

/**
 * 还原 localStorage 里的选择。
 *
 * 旧版本存的是 `"provider/model"` 字符串；它和新格式对不上，所以按缺失处理，
 * 由调用方回落到第一个可用模型。
 */
export function parseModelRef(raw: string | null): ModelRef | undefined {
  if (!raw) {
    return undefined;
  }
  try {
    return readModelRef(JSON.parse(raw));
  } catch {
    return undefined;
  }
}
