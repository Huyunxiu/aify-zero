import { randomUUID } from "node:crypto";

import { withOpencodeHeaders } from "@workspace/agent/model/opencode";

import type { ModalityName } from "./settings.schema";

/** 供应商列表接口返回的一条模型。能力字段拿不到就留空，由用户填。 */
export interface ListedModel {
  id: string;
  name: string;
  context?: number;
  input?: ModalityName[];
  output?: ModalityName[];
}

export interface FetchModelListInput {
  baseURL: string;
  apiKey: string;
  headers?: Record<string, string>;
}

/** 列表读不回来。`reason` 是给用户看的一句话，来自状态码或异常。 */
export class ModelListError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.name = "ModelListError";
    this.reason = reason;
  }
}

const KNOWN_MODALITIES = new Set<ModalityName>([
  "text",
  "audio",
  "image",
  "video",
  "pdf",
]);

function modalityList(input: unknown): ModalityName[] | undefined {
  if (!Array.isArray(input)) {
    return undefined;
  }
  const values = input.filter(
    (item): item is ModalityName =>
      typeof item === "string" && KNOWN_MODALITIES.has(item as ModalityName)
  );
  return values.length > 0 ? values : undefined;
}

function numberOf(...candidates: unknown[]): number | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function firstString(...candidates: unknown[]): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.length > 0) {
      return candidate;
    }
  }
  return undefined;
}

/** 供应商之间的差别就在这里：同样是 `/models`，字段名各不相同。 */
function toListedModel(raw: unknown): ListedModel | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const item = raw as Record<string, unknown>;
  // 有的服务商把模型名放在 id，有的放在 name。
  const id = firstString(item.id, item.model, item.name);
  if (!id) {
    return undefined;
  }
  const architecture =
    item.architecture && typeof item.architecture === "object"
      ? (item.architecture as Record<string, unknown>)
      : {};
  const limit =
    item.limit && typeof item.limit === "object"
      ? (item.limit as Record<string, unknown>)
      : {};
  const topProvider =
    item.top_provider && typeof item.top_provider === "object"
      ? (item.top_provider as Record<string, unknown>)
      : {};

  const context = numberOf(
    item.context_length,
    item.context_window,
    item.max_context_length,
    limit.context,
    topProvider.context_length
  );
  const input = modalityList(
    item.input_modalities ??
      architecture.input_modalities ??
      (item.modalities as Record<string, unknown> | undefined)?.input
  );
  const output = modalityList(
    item.output_modalities ??
      architecture.output_modalities ??
      (item.modalities as Record<string, unknown> | undefined)?.output
  );

  return {
    id,
    name: firstString(item.name, item.display_name, id) ?? id,
    ...(context === undefined ? {} : { context }),
    ...(input === undefined ? {} : { input }),
    ...(output === undefined ? {} : { output }),
  };
}

function unwrap(payload: unknown): unknown[] {
  if (Array.isArray(payload)) {
    return payload;
  }
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    for (const key of ["data", "models", "items"]) {
      if (Array.isArray(record[key])) {
        return record[key] as unknown[];
      }
    }
  }
  return [];
}

/**
 * 读供应商的模型列表。
 *
 * 兼作连接测试：地址、密钥或请求头有问题都会在这里以一句话报出来，而不是
 * 等到第一次对话才失败。
 */
export async function fetchModelList(
  input: FetchModelListInput
): Promise<ListedModel[]> {
  const baseURL = input.baseURL.trim().replace(/\/+$/, "");
  if (!baseURL) {
    throw new ModelListError("the base URL is empty");
  }

  const headers: Record<string, string> = {
    Accept: "application/json",
    ...withOpencodeHeaders({
      baseURL,
      sessionId: randomUUID(),
      headers: input.headers,
    }),
  };
  // 用户显式配了 Authorization 就照他的来；密钥只是默认值。
  const hasAuthorization = Object.keys(headers).some(
    (name) => name.toLowerCase() === "authorization"
  );
  if (input.apiKey && !hasAuthorization) {
    headers.Authorization = `Bearer ${input.apiKey}`;
  }

  let response: Response;
  try {
    response = await fetch(`${baseURL}/models`, {
      headers,
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new ModelListError(
      error instanceof Error ? error.message : "the request failed"
    );
  }

  if (!response.ok) {
    throw new ModelListError(`the provider answered ${response.status}`);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ModelListError("the answer is not JSON");
  }

  const models = unwrap(payload)
    .map(toListedModel)
    .filter((model): model is ListedModel => model !== undefined)
    .toSorted((left, right) => left.id.localeCompare(right.id));

  if (models.length === 0) {
    throw new ModelListError("the list is empty");
  }
  return models;
}
