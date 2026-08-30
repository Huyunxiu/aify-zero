import { Button as ButtonPrimitive } from "@base-ui/react/button"
import { CheckIcon, CopyIcon } from "lucide-react";
import { Button, buttonVariants } from "./button";
import { useCopyToClipboard } from "../hooks/use-copy-to-clipboard";
import type { TextUIPart } from "ai";
import type { VariantProps } from "class-variance-authority";

export type CopyButtonProps = ButtonPrimitive.Props & VariantProps<typeof buttonVariants> & { loading?: boolean } & {
  message: TextUIPart | undefined;
  label: string;
}

export function CopyButton({ message, label, ...props }: CopyButtonProps) {
  const { copyToClipboard, isCopied } = useCopyToClipboard();

  const handleCopy = () => {
    if (!message?.text) {
      return;
    }

    copyToClipboard(message?.text);
  };

  return (
    <Button
      aria-label={isCopied ? "Copied" : "Copy to clipboard"}
      onClick={handleCopy}
      size="icon"
      variant="outline"
      {...props}
    >
      {isCopied ? (
        <CheckIcon aria-hidden="true" />
      ) : (
        <CopyIcon aria-hidden="true" />
      )}
      <span className="sr-only">{label}</span>
    </Button>
  );
}
