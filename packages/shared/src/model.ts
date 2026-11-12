/**
 * 模型调用协议。
 *
 * 一个供应商只用一种协议；同一家要用两种就配两条供应商。
 */
export const MODEL_PROTOCOLS = ["openai-chat", "openai-responses"] as const;

export type ModelProtocol = (typeof MODEL_PROTOCOLS)[number];

/**
 * 唯一确定一个可调用模型的引用。
 *
 * 不用 `"provider/model"` 字符串：OpenRouter 一类供应商的模型 id 自带 `/`，
 * 拼接会产生歧义。
 */
export interface ModelRef {
  providerId: string;
  modelId: string;
}

/** 名字 → id。只留小写字母、数字和连字符：id 会出现在引用和 metadata 里。 */
export function slugifyProviderId(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "provider";
}

/** 内置的供应商预设：用户只填密钥，地址和控制台入口都已给出。 */
export interface ProviderPreset {
  id: string;
  name: string;
  protocol: ModelProtocol;
  /** 基地址。协议决定 SDK 追加的路径。 */
  baseURL: string;
  website: string;
  keysURL: string;
  /** 预设默认要发的请求头。 */
  headers?: Readonly<Record<string, string>>;
}

/** 预设清单。顺序即界面上展示的顺序。 */
export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    id: "openrouter",
    name: "OpenRouter",
    protocol: "openai-chat",
    baseURL: "https://openrouter.ai/api/v1",
    website: "https://openrouter.ai",
    keysURL: "https://openrouter.ai/keys",
  },
  {
    id: "opencode-zen",
    name: "OpenCode Zen",
    protocol: "openai-chat",
    baseURL: "https://opencode.ai/zen/v1",
    website: "https://opencode.ai/docs/zen",
    keysURL: "https://opencode.ai/auth",
  },
  {
    id: "opencode-go",
    name: "OpenCode Go",
    protocol: "openai-chat",
    baseURL: "https://opencode.ai/zen/go/v1",
    website: "https://opencode.ai/docs/go",
    keysURL: "https://opencode.ai/auth",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    protocol: "openai-chat",
    baseURL: "https://api.deepseek.com/v1",
    website: "https://platform.deepseek.com",
    keysURL: "https://platform.deepseek.com/api_keys",
  },
  {
    id: "openai",
    name: "OpenAI",
    protocol: "openai-responses",
    baseURL: "https://api.openai.com/v1",
    website: "https://platform.openai.com",
    keysURL: "https://platform.openai.com/api-keys",
  },
  {
    id: "google",
    name: "Google Gemini",
    protocol: "openai-chat",
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
    website: "https://ai.google.dev",
    keysURL: "https://aistudio.google.com/apikey",
  },
  {
    id: "zhipu",
    name: "智谱 AI",
    protocol: "openai-chat",
    baseURL: "https://open.bigmodel.cn/api/paas/v4",
    website: "https://open.bigmodel.cn",
    keysURL: "https://open.bigmodel.cn/usercenter/proj-mgmt/apikeys",
  },
  {
    id: "moonshot",
    name: "Kimi",
    protocol: "openai-chat",
    baseURL: "https://api.moonshot.cn/v1",
    website: "https://platform.moonshot.cn",
    keysURL: "https://platform.moonshot.cn/console/api-keys",
  },
  {
    id: "volcengine",
    name: "火山方舟",
    protocol: "openai-chat",
    baseURL: "https://ark.cn-beijing.volces.com/api/v3",
    website: "https://www.volcengine.com/product/ark",
    keysURL: "https://ark.volcengine.com/region:cn-beijing/apikey",
  },
  {
    id: "tencent",
    name: "腾讯云 TokenHub",
    protocol: "openai-chat",
    baseURL: "https://tokenhub.tencentmaas.com/v1",
    website: "https://cloud.tencent.com/document/product/1823",
    keysURL: "https://console.cloud.tencent.com/tokenhub/apikey",
  },
];
