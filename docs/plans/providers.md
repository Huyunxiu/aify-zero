# 供应商为主的模型配置

把「模型」这一层从接入信息里拆出来。供应商持有 API 地址、协议、密钥和请求头，
模型只描述模型本身，并挂在供应商下面。加一家供应商不再等于把同一个密钥和地址
重复填进它的每个模型。

## 决策

| 决策           | 结论                                                                         |
| -------------- | ---------------------------------------------------------------------------- |
| 数据形状       | `providers[]`，模型内嵌在供应商的 `models[]` 里                              |
| 模型引用       | `{ providerId, modelId }` 对象，贯穿设置、请求、事件、子 agent、localStorage |
| 供应商身份     | 内置预设加自定义；预设给地址、控制台地址、Key 申请地址                       |
| 接入信息       | 供应商持有 `baseURL`、`protocol`、`apiKey`、`headers`                        |
| 协议           | `openai-chat` 与 `openai-responses`；不做 Anthropic Messages                 |
| Responses 实现 | `@ai-sdk/openai`；API 地址仍填 base，SDK 追加路径                            |
| API 地址规范化 | 去尾斜杠，按协议去掉误填的 `/chat/completions`、`/responses`                 |
| 加模型         | 拉 `GET {baseURL}/models` 勾选，手填兜底；拉取兼作连接测试                   |
| 能力字段       | `limit.context`、`modalities`、`reasoning` 全部接线                          |
| 能力来源       | 从列表响应尽力解析，其余手填；不接 models.dev                                |
| 能力校验       | 前端隐藏入口，服务端拒绝不支持的内容；档位对不支持推理的模型直接忽略         |
| 网关           | 按模型引用解析，补丁换到别家就换地址与密钥                                   |
| `active`       | 供应商与模型都生效，关掉的不出现也调不到                                     |
| `defaultModel` | 新会话的初值；localStorage 里的选择优先                                      |
| 密钥输入       | 密码框，已存时显示掩码，留空表示不修改                                       |
| 旧数据         | 读取时归一化，下一次保存才落库                                               |
| 身份漂移       | 归一化按 `provider` 字段重建，不信任旧 id 前缀                               |
| 界面           | 一个供应商页，行内展开模型                                                   |
| 追踪           | step 事件保留模型 id，新增 `providerId`                                      |

## 数据结构

```ts
type ModelProtocol = "openai-chat" | "openai-responses";

/** 唯一确定一个可调用模型的引用。 */
type ModelRef = { providerId: string; modelId: string };

type Provider = {
  id: string; // slug，不含 "/"
  name: string;
  protocol: ModelProtocol;
  baseURL: string;
  apiKey: string;
  headers?: Record<string, string>;
  active: boolean;
  models: ProviderModel[];
};

type ProviderModel = {
  id: string; // 模型 id：上游用来标识它，可以自带 "/"
  name: string;
  active: boolean;
  reasoning: boolean;
  modalities: { input: Modality[]; output: Modality[] };
  limit: { context: number };
};
```

`ModelRef` 用两个字段而不是 `"provider/model"` 字符串：OpenRouter 一类供应商的
模型 id 自带 `/`（`anthropic/claude-x`），拼接会产生歧义。设置里需要按模型索引
的地方用嵌套记录，不再拼字符串。

## 旧设置的归一化

`user.settings` 是 `dict` 表里的一段 JSON，读取时过一遍 schema。旧形状的 `models[]`
每条都带自己的 `provider` / `apiUrl` / `apiKey`。

- 已有 `providers` 时直接用，忽略旧的 `models`。
- 否则按 `(provider, apiUrl, apiKey)` 归并旧记录，一组一条供应商。
- 供应商 id 由名字生成 slug，重复时加序号。
- 模型 id 取旧记录的 `model` 字段，不取旧 id 的前缀：`local.db` 里存在
  `Maas/ling-3.0-flash-sante` 配 `provider = "AntGroup"` 这种漂移。
- 旧 `defaultModel` 是字符串，按第一个 `/` 拆开再校验；校验失败置 `null`。

归一化是纯函数且幂等，只在读取时跑；写库发生在用户下一次保存。

## 协议

两条适配路径，都只做协议转换，不缓存模型对象。

| 协议               | 依赖                        | 请求路径                        |
| ------------------ | --------------------------- | ------------------------------- |
| `openai-chat`      | `@ai-sdk/openai-compatible` | `baseURL` + `/chat/completions` |
| `openai-responses` | `@ai-sdk/openai`            | `baseURL` + `/responses`        |

OpenCode 的网关要求额外的请求头，缺 `x-opencode-session` 直接 400。网关在目标
主机是 `opencode.ai` 或其子域时补一整套头，其中包括由会话 id 派生的会话头。
版本号用常量，用户可以用供应商的自定义请求头覆盖。

## 模块

| 路径                                                         | 职责                                            |
| ------------------------------------------------------------ | ----------------------------------------------- |
| `packages/shared/src/model.ts`                               | `ModelRef`、`ModelProtocol`、`PROVIDER_PRESETS` |
| `packages/server/src/routers/settings/settings.schema.ts`    | 供应商与模型的 schema，设置形状                 |
| `packages/server/src/routers/settings/settings.normalize.ts` | 旧设置归一化与 API 地址规范化                   |
| `packages/server/src/routers/settings/settings.service.ts`   | 读写设置、按引用找模型                          |
| `packages/server/src/routers/settings/model-list.ts`         | 拉取并解析 `/models`                            |
| `packages/server/src/session/agent.ts`                       | 把供应商配置解析成网关目标                      |
| `packages/agent/src/model/gateway.ts`                        | 两种协议的适配器与 OpenCode 请求头              |
| `packages/ui/src/elements/settings/provider-settings.tsx`    | 供应商页                                        |

## 预设

| 供应商          | API 地址                                                  | 默认协议  |
| --------------- | --------------------------------------------------------- | --------- |
| OpenRouter      | `https://openrouter.ai/api/v1`                            | chat      |
| OpenCode Zen    | `https://opencode.ai/zen/v1`                              | chat      |
| OpenCode Go     | `https://opencode.ai/zen/go/v1`                           | chat      |
| DeepSeek        | `https://api.deepseek.com/v1`                             | chat      |
| OpenAI          | `https://api.openai.com/v1`                               | responses |
| Google Gemini   | `https://generativelanguage.googleapis.com/v1beta/openai` | chat      |
| 智谱            | `https://open.bigmodel.cn/api/paas/v4`                    | chat      |
| Kimi            | `https://api.moonshot.cn/v1`                              | chat      |
| 火山方舟        | `https://ark.cn-beijing.volces.com/api/v3`                | chat      |
| 腾讯云 TokenHub | `https://tokenhub.tencentmaas.com/v1`                     | chat      |

## 不做

- Anthropic Messages 协议。清单里没有只能走它的供应商。
- models.dev 目录。它要引入外部目录、缓存和快照，是独立子系统。
- OpenCode 免费模型的路径改写与工具伪装。
