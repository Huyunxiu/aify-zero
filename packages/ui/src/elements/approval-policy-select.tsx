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
 * The Approval Policy selector of a session.
 *
 * It selects whether to ask, not whether the action can run: the Sandbox decides that.
 * So the text never says "permission", and the loosest class has its own note.
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
