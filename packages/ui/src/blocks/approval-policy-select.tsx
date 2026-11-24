import type { ApprovalPolicy } from "@workspace/agent-client";
import { APPROVAL_POLICIES } from "@workspace/agent-client";
import type { LucideIcon } from "lucide-react";
import { LockIcon, PencilLineIcon, ShieldOffIcon } from "lucide-react";
import { useTranslation } from "react-i18next";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "../components/dropdown-menu";
import { PromptInputButton } from "./prompt-input";

/** One mark for each posture, so the toolbar reads at a glance and each row repeats it. */
const POLICY_ICONS: Record<ApprovalPolicy, LucideIcon> = {
  readonly: LockIcon,
  edit: PencilLineIcon,
  unrestricted: ShieldOffIcon,
};

export type ApprovalPolicySelectProps = {
  approvalPolicy: ApprovalPolicy;
  onApprovalPolicyChange: (policy: ApprovalPolicy) => void;
};

/**
 * The Approval Policy selector of a session.
 *
 * It selects whether to ask, not whether the action can run: the Sandbox decides that.
 * So the text never says "permission", and the loosest class has its own note.
 *
 * A menu of radio items, not a Command palette: three answers that never change need no
 * search, and `menuitemradio` tells a screen reader which answer is current. The palette
 * painted the current row and left its state unannounced.
 */
export function ApprovalPolicySelect({
  approvalPolicy,
  onApprovalPolicyChange,
}: ApprovalPolicySelectProps) {
  const { t } = useTranslation();
  const CurrentIcon = POLICY_ICONS[approvalPolicy];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<PromptInputButton />}>
        <CurrentIcon className="size-4" />
        <span>{t(`approvalPolicy.values.${approvalPolicy}`)}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="min-w-64">
        <DropdownMenuRadioGroup
          onValueChange={(value: ApprovalPolicy) =>
            onApprovalPolicyChange(value)
          }
          value={approvalPolicy}
        >
          <DropdownMenuLabel>{t("approvalPolicy.label")}</DropdownMenuLabel>
          {APPROVAL_POLICIES.map((policy) => {
            const PolicyIcon = POLICY_ICONS[policy];

            return (
              <DropdownMenuRadioItem
                className="items-start py-1.5"
                // `Menu.RadioItem` keeps the menu open by default, unlike
                // `Menu.Item`; a picker closes on the pick.
                closeOnClick
                key={policy}
                value={policy}
              >
                <PolicyIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <div className="flex flex-col gap-0.5">
                  <span>{t(`approvalPolicy.values.${policy}`)}</span>
                  <span className="text-muted-foreground text-xs">
                    {t(`approvalPolicy.hints.${policy}`)}
                  </span>
                </div>
              </DropdownMenuRadioItem>
            );
          })}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
