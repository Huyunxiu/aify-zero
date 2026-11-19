import type { ApprovalPolicy } from "@workspace/agent-client";
import { APPROVAL_POLICIES } from "@workspace/agent-client";
import { ShieldCheckIcon } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import {
  Command,
  CommandGroup,
  CommandItem,
  CommandList,
} from "../components/command";
import { Popover, PopoverContent, PopoverTrigger } from "../components/popover";
import { cn } from "../lib/utils";
import { PromptInputButton } from "./prompt-input";

export type ApprovalPolicySelectProps = {
  approvalPolicy: ApprovalPolicy;
  onApprovalPolicyChange: (policy: ApprovalPolicy) => void;
};

/**
 * 会话的审批档位选择器。
 *
 * 它选的是「问不问」，不是「能不能」：能不能做仍由沙箱决定。所以文案里不
 * 出现「权限」；最宽的那一档单独写了提醒。
 */
export function ApprovalPolicySelect({
  approvalPolicy,
  onApprovalPolicyChange,
}: ApprovalPolicySelectProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger className="w-fit" render={<div />} nativeButton={false}>
        <PromptInputButton>
          <ShieldCheckIcon className="size-4" />
          <span>{t(`approvalPolicy.values.${approvalPolicy}`)}</span>
        </PromptInputButton>
      </PopoverTrigger>
      <PopoverContent align="center" className="p-0">
        <Command className="p-0">
          <CommandList>
            <CommandGroup heading={t("approvalPolicy.label")}>
              {APPROVAL_POLICIES.map((policy) => (
                <CommandItem
                  className={cn(
                    "flex flex-col items-start gap-0.5",
                    policy === approvalPolicy && "bg-accent"
                  )}
                  key={policy}
                  onSelect={() => {
                    onApprovalPolicyChange(policy);
                    setOpen(false);
                  }}
                  value={policy}
                >
                  <span>{t(`approvalPolicy.values.${policy}`)}</span>
                  <span className="text-muted-foreground text-xs">
                    {t(`approvalPolicy.hints.${policy}`)}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
