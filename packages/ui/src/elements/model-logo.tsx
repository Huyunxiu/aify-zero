import { BrandIcon, hasIcon } from "./brand-icon";

/**
 * 模型 id 前缀 → 模型出品方的图标键。顺序即优先级。
 *
 * 这张表画出品方，不画版本：模型 id 里的版本号（`claude-3-5`、`gpt-4o`）不参与
 * 匹配，同一家的两个版本画同一张图。
 */
export const MAKER_PREFIXES: readonly (readonly [string, string])[] = [
  ["claude", "claude-color"],
  ["gpt", "openai"],
  ["o1", "openai"],
  ["o3", "openai"],
  ["o4", "openai"],
  ["codex", "openai"],
  ["gemini", "gemini-color"],
  ["gemma", "gemini-color"],
  ["deepseek", "deepseek-color"],
  ["grok", "xai"],
  ["kimi", "kimi"],
  ["moonshot", "kimi"],
  ["glm", "zhipu-color"],
  ["qwen", "qwen-color"],
  ["qwq", "qwen-color"],
  ["mistral", "mistral-color"],
  ["codestral", "mistral-color"],
  ["devstral", "mistral-color"],
  ["magistral", "mistral-color"],
  ["minimax", "minimax-color"],
  ["mimo", "mimocode"],
  ["xiaomi", "mimocode"],
  ["step", "stepfun-color"],
];

/** 按模型 id 找出品方的图标键；找不到返回 undefined。 */
export function makerKeyFor(model: string): string | undefined {
  const lower = model.toLowerCase();
  // 中转站的模型 id 常带 `vendor/` 前缀，取后半段再匹配。
  const slash = lower.indexOf("/");
  const id = slash === -1 ? lower : lower.slice(slash + 1);
  return MAKER_PREFIXES.find(([prefix]) => id.startsWith(prefix))?.[1];
}

/** 模型能定下的图标键：显式键 → 出品方 → 所属供应商 → 中性图标。 */
export function modelIconKey(input: {
  model: string;
  icon?: string;
  providerIcon?: string;
}): string {
  return (
    (input.icon && hasIcon(input.icon) ? input.icon : undefined) ??
    makerKeyFor(input.model) ??
    (input.providerIcon && hasIcon(input.providerIcon)
      ? input.providerIcon
      : undefined) ??
    "generic"
  );
}

interface ModelLogoProps {
  model: string;
  /** 直接指定图标键，优先于 id 匹配。 */
  icon?: string;
  /** 所属供应商的图标键：模型 id 认不出出品方时用它。 */
  providerIcon?: string;
  className?: string;
}

/**
 * 模型的图标。
 *
 * 中转站下面挂着别家的模型时，画的是出品方，不是中转站。都认不出才画中性图标，
 * 不给它安一个假品牌。
 */
export function ModelLogo({
  model,
  icon,
  providerIcon,
  className,
}: ModelLogoProps) {
  const key = modelIconKey({ model, icon, providerIcon });
  return <BrandIcon className={className} name={key} />;
}
