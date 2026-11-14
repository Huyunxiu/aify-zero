import DeepSeekLogo from "../assets/logo/deepseek.svg";
import GeminiLogo from "../assets/logo/gemini.svg";
import KimiLogo from "../assets/logo/kimi.svg";
import MinimaxLogo from "../assets/logo/minimax.svg";
import MoonshotLogo from "../assets/logo/moonshot.svg";
import OpenAILogo from "../assets/logo/openai.svg";
import OpenCodeLogo from "../assets/logo/opencode.svg";
import OpenRouterLogo from "../assets/logo/openrouter.svg";
import QwenLogo from "../assets/logo/qwen.svg";
import TencentCloudLogo from "../assets/logo/tencentcloud.svg";
import VolcengineLogo from "../assets/logo/volcengine.svg";
import ZhipuLogo from "../assets/logo/zhipu.svg";
import { cn } from "../lib/utils";

interface LogoEntry {
  src: string;
  /** 单色图不写死颜色，用 mask 跟随文字颜色，深色主题下也看得见。 */
  monochrome?: boolean;
}

/** 认不出品牌时的兜底图。 */
const FALLBACK_LOGO: LogoEntry = { src: OpenAILogo, monochrome: true };

const LOGO_MAP: Record<string, LogoEntry> = {
  deepseek: { src: DeepSeekLogo },
  gemini: { src: GeminiLogo },
  kimi: { src: KimiLogo, monochrome: true },
  minimax: { src: MinimaxLogo },
  moonshot: { src: MoonshotLogo, monochrome: true },
  openai: FALLBACK_LOGO,
  opencode: { src: OpenCodeLogo, monochrome: true },
  openrouter: { src: OpenRouterLogo, monochrome: true },
  qwen: { src: QwenLogo },
  tencentcloud: { src: TencentCloudLogo },
  volcengine: { src: VolcengineLogo },
  zhipu: { src: ZhipuLogo },
};

/** 名字里的品牌词 → 图标键。 */
const LOGO_ALIASES: Record<string, readonly string[]> = {
  deepseek: ["deepseek", "深度求索"],
  gemini: ["gemini", "google"],
  kimi: ["kimi"],
  minimax: ["minimax"],
  moonshot: ["moonshot"],
  openai: ["openai", "gpt-"],
  opencode: ["opencode"],
  openrouter: ["openrouter"],
  qwen: ["qwen", "通义"],
  tencentcloud: ["tencent", "tokenhub", "腾讯"],
  volcengine: ["volcengine", "volces", "火山", "方舟", "豆包", "doubao"],
  zhipu: ["zhipu", "glm", "智谱", "bigmodel"],
};

/** 图标表里有没有这个键。 */
export function hasLogo(key: string): boolean {
  return key in LOGO_MAP;
}

/** 按名字找品牌图标键；找不到返回 undefined，界面自己退回首字母。 */
export function logoKeyFor(name: string): string | undefined {
  const lower = name.toLowerCase();
  return Object.keys(LOGO_ALIASES).find((key) =>
    LOGO_ALIASES[key]?.some((alias) => lower.includes(alias))
  );
}

interface ModelLogoProps {
  model: string;
  /** 直接指定图标键，优先于名字匹配。 */
  icon?: string;
  className?: string;
}

export function ModelLogo({ model, icon, className }: ModelLogoProps) {
  const key = (icon && hasLogo(icon) ? icon : logoKeyFor(model)) ?? "";
  const entry = LOGO_MAP[key] ?? FALLBACK_LOGO;

  if (entry.monochrome) {
    const maskImage = `url("${entry.src}")`;
    return (
      <span
        aria-hidden="true"
        className={cn("inline-block size-4 shrink-0 bg-current", className)}
        style={{
          WebkitMaskImage: maskImage,
          WebkitMaskPosition: "center",
          WebkitMaskRepeat: "no-repeat",
          WebkitMaskSize: "contain",
          maskImage,
          maskPosition: "center",
          maskRepeat: "no-repeat",
          maskSize: "contain",
        }}
      />
    );
  }

  return (
    <img
      alt={model}
      className={cn("size-4 shrink-0", className)}
      src={entry.src}
    />
  );
}
