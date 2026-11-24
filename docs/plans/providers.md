# Provider-first model configuration

This plan takes the model layer out of the access config. A provider holds the API URL, the
protocol, the key, and the request headers. A model describes only the model itself, and it
belongs to a provider. Adding a provider no longer means that the user enters the same key and
the same URL in each of its models.

## Decisions

| Decision                 | Outcome                                                                                                                    |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| Data shape               | `providers[]`, with each model inside the `models[]` of its provider                                                       |
| Model ref                | Settings, requests, events, subagents, and localStorage all carry the object `{ providerId, modelId }`                     |
| Provider identity        | A built-in preset or a custom provider. A preset supplies the API URL, the console URL, and the key URL                    |
| Access config            | The provider holds `baseURL`, `protocol`, `apiKey`, and `headers`                                                          |
| Protocol                 | `openai-chat` and `openai-responses`. Anthropic Messages is out of scope                                                   |
| Responses implementation | `@ai-sdk/openai`. The user enters the base API URL, and the SDK appends the path                                           |
| API URL normalization    | The code removes the trailing slash. Per protocol, it removes a mistaken `/chat/completions` or `/responses`               |
| Add a model              | Fetch `GET {baseURL}/models` and select entries. Manual input is the fallback, and the fetch tests the connection          |
| Capability fields        | The code wires `limit.context`, `modalities`, and `reasoning`                                                              |
| Capability source        | The code parses what it can from the list response, and the user enters the rest. There is no models.dev                   |
| Capability validation    | The interface hides the entry. The server rejects an unsupported value. It ignores the level for a model without reasoning |
| Gateway                  | The gateway resolves a model ref. A patch that selects another provider changes the URL and the key                        |
| `active`                 | It applies to the provider and to the model. A provider or model that is off does not appear and cannot be called          |
| `defaultModel`           | The initial value for a new session. A selection in localStorage has priority                                              |
| Key input                | A password field. When a key is stored, the field shows a mask, and an empty field means no change                         |
| Old data                 | The code normalizes it at read time and writes it to the database at the next save                                         |
| Identity drift           | Normalization rebuilds from the `provider` field and does not trust an old id prefix                                       |
| Interface                | One provider page. Each provider expands its models in the row                                                             |
| Tracking                 | A step event keeps the model id and adds `providerId`                                                                      |

## Data structure

```ts
type ModelProtocol = "openai-chat" | "openai-responses";

/** The reference that identifies one callable model. */
type ModelRef = { providerId: string; modelId: string };

type Provider = {
  id: string; // slug, without "/"
  name: string;
  protocol: ModelProtocol;
  baseURL: string;
  apiKey: string;
  headers?: Record<string, string>;
  active: boolean;
  models: ProviderModel[];
};

type ProviderModel = {
  id: string; // model id: the upstream identifies the model with it, and it may contain "/"
  name: string;
  active: boolean;
  reasoning: boolean;
  modalities: { input: Modality[]; output: Modality[] };
  limit: { context: number };
};
```

`ModelRef` uses two fields, not a `"provider/model"` string. A provider such as OpenRouter
keeps a `/` in its model id (`anthropic/claude-x`), so a join is ambiguous. Where settings
index by model, a nested record replaces the joined string.

## Old settings normalization

`user.settings` is one JSON value in the `dict` table, and the code reads it through the
schema. Each entry of the old `models[]` carries its own `provider`, `apiUrl`, and `apiKey`.

- If `providers` exists, the code uses it and ignores the old `models`.
- Otherwise the code groups the old records by `(provider, apiUrl, apiKey)`, and each group
  becomes one provider.
- The code makes the provider id from a slug of the name, and it adds a number on a repeat.
- The model id comes from the `model` field of the old record, not from the prefix of the old
  id. `local.db` holds drift such as `Maas/ling-3.0-flash-sante` with `provider = "AntGroup"`.
- The old `defaultModel` is a string, so the code splits it at the first `/` and then validates
  it. If validation fails, the value becomes `null`.

Normalization is a pure function, and it is idempotent. It runs at read time only. The code
writes the database only at the next save by the user.

## Protocol

The code has two adapter paths. Both paths only convert the protocol, and neither caches a
model object.

| Protocol           | Dependency                  | Request path                    |
| ------------------ | --------------------------- | ------------------------------- |
| `openai-chat`      | `@ai-sdk/openai-compatible` | `baseURL` + `/chat/completions` |
| `openai-responses` | `@ai-sdk/openai`            | `baseURL` + `/responses`        |

The OpenCode gateway requires extra request headers. The gateway returns 400 for a request
without `x-opencode-session`. When the target host is `opencode.ai` or one of its
subdomains, the gateway adds the full header set. That set includes a session header that
the code derives from the session id. The version number comes from a constant, and a custom
header of the provider can override it.

## Modules

| Path                                                         | Responsibility                                             |
| ------------------------------------------------------------ | ---------------------------------------------------------- |
| `packages/shared/src/model.ts`                               | `ModelRef`, `ModelProtocol`, and `PROVIDER_PRESETS`        |
| `packages/server/src/routers/settings/settings.schema.ts`    | The provider and model schema, and the settings shape      |
| `packages/server/src/routers/settings/settings.normalize.ts` | Old settings normalization and API URL normalization       |
| `packages/server/src/routers/settings/settings.service.ts`   | Read and write settings, and find a model by its ref       |
| `packages/server/src/routers/settings/model-list.ts`         | Fetch and parse `/models`                                  |
| `packages/server/src/session/agent.ts`                       | Resolve a provider config to a gateway target              |
| `packages/agent/src/model/gateway.ts`                        | The adapters of the two protocols and the OpenCode headers |
| `packages/ui/src/blocks/settings/provider-settings.tsx`      | The provider page                                          |

## Presets

| Provider        | API URL                                                   | Default protocol |
| --------------- | --------------------------------------------------------- | ---------------- |
| OpenRouter      | `https://openrouter.ai/api/v1`                            | chat             |
| OpenCode Zen    | `https://opencode.ai/zen/v1`                              | chat             |
| OpenCode Go     | `https://opencode.ai/zen/go/v1`                           | chat             |
| DeepSeek        | `https://api.deepseek.com/v1`                             | chat             |
| OpenAI          | `https://api.openai.com/v1`                               | responses        |
| Google Gemini   | `https://generativelanguage.googleapis.com/v1beta/openai` | chat             |
| 智谱            | `https://open.bigmodel.cn/api/paas/v4`                    | chat             |
| Kimi            | `https://api.moonshot.cn/v1`                              | chat             |
| 火山方舟        | `https://ark.cn-beijing.volces.com/api/v3`                | chat             |
| 腾讯云 TokenHub | `https://tokenhub.tencentmaas.com/v1`                     | chat             |

## Out of scope

- The Anthropic Messages protocol. No provider in the list uses only that protocol.
- The models.dev catalogue. It brings an external catalogue, a cache, and a snapshot, so it is
  a separate subsystem.
- The path rewrite and the tool disguise of the free OpenCode models.
