import DeepSeekLogo from "../assets/logo/deepseek.svg";
import MinimaxLogo from "../assets/logo/minimax.svg";
import MoonshotLogo from "../assets/logo/moonshot.svg";
import OpenAILogo from "../assets/logo/openai.svg";
import QwenLogo from "../assets/logo/qwen.svg";
import { cn } from "../lib/utils";

const LOGO_MAP: Record<string, string> = {
  deepseek: DeepSeekLogo,
  minimax: MinimaxLogo,
  moonshot: MoonshotLogo,
  openai: OpenAILogo,
  qwen: QwenLogo,
};

interface ModelLogoProps extends React.ComponentProps<"img"> {
  model: string;
}

export function ModelLogo({ model, className, ...props }: ModelLogoProps) {
  const lower = model.toLowerCase();
  const matchedKey =
    Object.keys(LOGO_MAP).find((key) => lower.includes(key)) ?? "openai";
  return (
    <img
      src={LOGO_MAP[matchedKey]}
      className={cn("size-4", className)}
      alt={model}
      {...props}
    />
  );
}
