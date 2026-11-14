import { cn } from "../lib/utils";
import { BrandIcon, hasIcon } from "./brand-icon";

/** 名字里的品牌词 → 图标键。顺序即优先级。 */
const PROVIDER_ALIASES: Record<string, readonly string[]> = {
  "claude-color": ["claude", "anthropic"],
  "deepseek-color": ["deepseek", "深度求索"],
  "gemini-color": ["gemini", "gemma", "google", "谷歌"],
  kimi: ["kimi", "moonshot", "月之暗面"],
  "minimax-color": ["minimax"],
  "mistral-color": ["mistral"],
  mimocode: ["mimo", "xiaomi", "小米"],
  openai: ["openai", "chatgpt", "gpt-"],
  "qwen-color": ["qwen", "qwq", "通义", "千问"],
  "stepfun-color": ["stepfun", "step-"],
  xai: ["xai", "grok"],
  "zhipu-color": ["zhipu", "glm", "智谱", "bigmodel"],
  zai: ["z.ai"],
  "volcengine-color": [
    "volcengine",
    "volces",
    "火山",
    "方舟",
    "豆包",
    "doubao",
  ],
  "tencentcloud-color": ["tencent", "tokenhub", "腾讯"],
  "baiducloud-color": ["baidu", "qianfan", "百度", "千帆"],
  "bedrock-color": ["bedrock", "aws"],
  groq: ["groq"],
  longcat: ["longcat"],
  nousresearch: ["nous"],
  ollama: ["ollama"],
  "voyage-color": ["voyage"],
  openrouter: ["openrouter"],
  opencode: ["opencode"],
  vercel: ["vercel"],
  gmicloud: ["gmicloud"],
  "together-color": ["together"],
  "fireworks-color": ["fireworks"],
  "siliconcloud-color": ["silicon", "硅基"],
  "nvidia-color": ["nvidia"],
  "modelscope-color": ["modelscope", "魔搭"],
  "aihubmix-color": ["aihubmix"],
  "ai302-color": ["302"],
  "cherryin-color": ["cherryin", "cherry"],
  "cloudflare-color": ["cloudflare"],
  cline: ["cline"],
  kilo: ["kilo"],
  commandcode: ["commandcode"],
  "pipellm-color": ["pipellm"],
  yylx: ["yylx"],
};

/** 按名字找供应商的图标键；找不到返回 undefined。 */
export function providerKeyFor(name: string): string | undefined {
  const lower = name.toLowerCase();
  return Object.keys(PROVIDER_ALIASES).find((key) =>
    PROVIDER_ALIASES[key]?.some((alias) => lower.includes(alias))
  );
}

/** 供应商能定下的图标键：显式键优先，其次按名字找。 */
export function providerIconKey(input: {
  name: string;
  icon?: string;
}): string | undefined {
  if (input.icon && hasIcon(input.icon)) {
    return input.icon;
  }
  return providerKeyFor(input.name);
}

interface ProviderLogoProps {
  name: string;
  /** 直接指定图标键，优先于名字匹配。 */
  icon?: string;
  className?: string;
}

/**
 * 供应商的图标。
 *
 * 认不出品牌时画名字首字母：供应商的名字是用户自己填的，首字母比一个中性的图
 * 标更有信息。模型那一层不这样做，见 `ModelLogo`。
 */
export function ProviderLogo({ name, icon, className }: ProviderLogoProps) {
  const key = providerIconKey({ name, icon });
  if (key) {
    return <BrandIcon className={className} name={key} />;
  }
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-4 shrink-0 items-center justify-center rounded-md bg-muted font-medium text-[10px] text-foreground/70",
        className
      )}
    >
      {name.trim().slice(0, 1).toUpperCase()}
    </span>
  );
}
