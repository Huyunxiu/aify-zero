import type { ApprovalChoice } from "@workspace/agent-client";
import { APPROVAL_POLICIES } from "@workspace/agent-client";
import { ShieldCheckIcon } from "lucide-react";
import { useTranslation } from "react-i18next";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "../components/dropdown-menu";
import { PromptInputButton } from "./prompt-input";

export type ApprovalPolicySelectProps = {
  /** The picker offers the stored choices, never the posture an unattended run supplies. */
  approvalPolicy: ApprovalChoice;
  onApprovalPolicyChange: (policy: ApprovalChoice) => void;
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

  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<PromptInputButton />}>
        <ShieldCheckIcon className="size-4" />
        <span>{t(`approvalPolicy.values.${approvalPolicy}`)}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="min-w-64">
        <DropdownMenuRadioGroup
          onValueChange={(value: ApprovalChoice) =>
            onApprovalPolicyChange(value)
          }
          value={approvalPolicy}
        >
          <div className="px-1.5 py-1 font-medium text-muted-foreground text-xs">
            {t("approvalPolicy.label")}
          </div>
          {APPROVAL_POLICIES.map((policy) => (
            <DropdownMenuRadioItem
              className="items-start py-1.5"
              // `Menu.RadioItem` keeps the menu open by default, unlike
              // `Menu.Item`; a picker closes on the pick.
              closeOnClick
              key={policy}
              value={policy}
            >
              <div className="flex flex-col gap-0.5">
                <span>{t(`approvalPolicy.values.${policy}`)}</span>
                <span className="text-muted-foreground text-xs">
                  {t(`approvalPolicy.hints.${policy}`)}
                </span>
              </div>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
