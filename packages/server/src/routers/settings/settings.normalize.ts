import { slugifyProviderId } from "@workspace/shared/model";
import type { ModelProtocol } from "@workspace/shared/model";
import z from "zod";

import type { ModelRef, Provider, UserSettings } from "./settings.schema";
import {
  modelRefSchema,
  Modalities,
  providerSchema,
  userSettingsSchema,
} from "./settings.schema";

/** 旧设置里的一条模型：接入信息在每条上重复一遍。 */
const legacyAiModelSchema = z.object({
  name: z.string().optional(),
  provider: z.string(),
  model: z.string(),
  apiUrl: z.string(),
  apiKey: z.string(),
  active: z.boolean().optional(),
  reasoning: z.boolean().optional(),
  modalities: Modalities.optional(),
  limit: z.object({ context: z.number() }).optional(),
});

const LEGACY_RESPONSE_SUFFIX = "/responses";
const LEGACY_CHAT_SUFFIX = "/chat/completions";

/**
 * 把用户粘进来的地址收敛成 API 地址。
 *
 * SDK 会在 API 地址后追加协议路径；用户粘完整端点时，不收敛就会得到
 * `/chat/completions/chat/completions`。
 */
export function normalizeBaseURL(
  baseURL: string,
  protocol: ModelProtocol
): string {
  const trimmed = baseURL.trim().replace(/\/+$/, "");
  if (!trimmed) {
    return "";
  }
  const withScheme = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  const suffix =
    protocol === "openai-responses"
      ? LEGACY_RESPONSE_SUFFIX
      : LEGACY_CHAT_SUFFIX;
  return withScheme.endsWith(suffix)
    ? withScheme.slice(0, -suffix.length)
    : withScheme;
}

function uniqueId(base: string, taken: Set<string>): string {
  if (!taken.has(base)) {
    taken.add(base);
    return base;
  }
  for (let index = 2; ; index += 1) {
    const candidate = `${base}-${index}`;
    if (!taken.has(candidate)) {
      taken.add(candidate);
      return candidate;
    }
  }
}

/**
 * 旧设置迁移：按 `(provider, apiUrl, apiKey)` 归并成供应商。
 *
 * 模型 id 取旧记录的 `model` 字段，不取旧 `id` 的前缀：库里存在
 * `Maas/ling-3.0-flash-sante` 配 `provider = "AntGroup"` 这种漂移。
 */
function providersFromLegacyModels(models: unknown): Provider[] {
  if (!Array.isArray(models)) {
    return [];
  }

  interface Group {
    name: string;
    apiUrl: string;
    apiKey: string;
    models: Provider["models"];
  }

  const groups = new Map<string, Group>();
  for (const raw of models) {
    const parsed = legacyAiModelSchema.safeParse(raw);
    if (!parsed.success) {
      continue;
    }
    const entry = parsed.data;
    const key = [entry.provider, entry.apiUrl, entry.apiKey].join("\u0000");
    const baseURL = normalizeBaseURL(entry.apiUrl, "openai-chat");
    const model = {
      id: entry.model,
      name: entry.name || entry.model,
      active: entry.active ?? true,
      reasoning: entry.reasoning ?? true,
      modalities: entry.modalities ?? {
        input: ["text", "image"],
        output: ["text"],
      },
      limit: entry.limit ?? { context: 131_072 },
    } satisfies Provider["models"][number];

    const group = groups.get(key);
    if (group) {
      if (!group.models.some((existing) => existing.id === model.id)) {
        group.models.push(model);
      }
    } else {
      groups.set(key, {
        name: entry.provider,
        apiUrl: baseURL,
        apiKey: entry.apiKey,
        models: [model],
      });
    }
  }

  const taken = new Set<string>();
  return [...groups.values()].map((group) => ({
    id: uniqueId(slugifyProviderId(group.name), taken),
    name: group.name,
    protocol: "openai-chat" as const,
    baseURL: group.apiUrl,
    apiKey: group.apiKey,
    active: true,
    models: group.models,
  }));
}

/** 设置里的供应商；解析不了的条目丢掉，不让一条坏数据锁住整份设置。 */
function normalizeProviders(input: unknown): Provider[] {
  if (!Array.isArray(input)) {
    return [];
  }
  const taken = new Set<string>();
  const providers: Provider[] = [];
  for (const raw of input) {
    const parsed = providerSchema.safeParse(raw);
    if (!parsed.success) {
      continue;
    }
    const provider = parsed.data;
    providers.push({
      ...provider,
      id: uniqueId(provider.id || slugifyProviderId(provider.name), taken),
      baseURL: normalizeBaseURL(provider.baseURL, provider.protocol),
      models: provider.models.filter(
        (model, index, all) =>
          model.id.length > 0 &&
          all.findIndex((other) => other.id === model.id) === index
      ),
    });
  }
  return providers;
}

/** 默认模型：旧的字符串按第一个 `/` 拆开，再校验它确实还在。 */
function normalizeDefaultModel(
  input: unknown,
  providers: readonly Provider[]
): ModelRef | null {
  const has = (ref: ModelRef): boolean =>
    providers.some(
      (provider) =>
        provider.id === ref.providerId &&
        provider.models.some((model) => model.id === ref.modelId)
    );

  if (typeof input === "string") {
    const cut = input.indexOf("/");
    if (cut <= 0 || cut === input.length - 1) {
      return null;
    }
    const ref = {
      providerId: input.slice(0, cut),
      modelId: input.slice(cut + 1),
    };
    return has(ref) ? ref : null;
  }

  const parsed = modelRefSchema.safeParse(input);
  return parsed.success && has(parsed.data) ? parsed.data : null;
}

/**
 * 把存下来的设置收敛成当前形状。
 *
 * 幂等：已迁移的数据再跑一遍不会变。只在读取时跑，写库发生在用户下一次
 * 保存。
 */
export function normalizeUserSettings(
  stored: unknown,
  defaults: UserSettings
): UserSettings {
  const record =
    stored && typeof stored === "object"
      ? (stored as Record<string, unknown>)
      : {};
  const merged = { ...defaults, ...record } as Record<string, unknown> &
    UserSettings;
  // 读存在的那份，不是合并后的：默认值里也有 `providers`，拿它判断会让旧设置
  // 永远走不到迁移分支。
  const providers = Array.isArray(record.providers)
    ? normalizeProviders(record.providers)
    : providersFromLegacyModels(record.models);

  return userSettingsSchema.parse({
    ...merged,
    providers,
    defaultModel: normalizeDefaultModel(merged.defaultModel, providers),
  });
}
