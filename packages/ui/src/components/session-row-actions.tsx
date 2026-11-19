import { PencilIcon, Trash2Icon } from "lucide-react";
import { useTranslation } from "react-i18next";

import { DropdownMenuItem } from "./dropdown-menu";
import type { SessionStatus } from "./session-status";

/** 行操作只需要这几个字段，列表里拿到的会话够用。 */
export type RowActionSession = {
  id: string;
  title: string | null;
  status: SessionStatus;
};

type SessionRowMenuItemsProps = {
  session: RowActionSession;
  onRename: () => void;
  onDelete: () => void;
};

/**
 * 侧栏会话行的菜单项。
 *
 * 两条列表（全局与项目内）用的是同一套：删掉其中一处的按钮却不改另一处，用户会
 * 以为功能时有时无。运行中的会话不能删——一次正在花钱的运行不该被一条删除请求
 * 带走（ADR 0020）。
 */
export function SessionRowMenuItems({
  session,
  onRename,
  onDelete,
}: SessionRowMenuItemsProps) {
  const { t } = useTranslation();
  const running = session.status === "running";

  return (
    <>
      <DropdownMenuItem onClick={onRename}>
        <PencilIcon />
        {t("sessions.rename")}
      </DropdownMenuItem>
      <DropdownMenuItem
        variant="destructive"
        disabled={running}
        onClick={onDelete}
      >
        <Trash2Icon />
        {t("sessions.delete")}
      </DropdownMenuItem>
    </>
  );
}
