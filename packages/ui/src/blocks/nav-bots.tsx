import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { BotSummary } from "@workspace/agent-client";
import { generateSessionId } from "@workspace/agent-client";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@workspace/ui/components/collapsible";
import { DropdownMenuItem } from "@workspace/ui/components/dropdown-menu";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@workspace/ui/components/sidebar";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip";
import {
  ChevronDownIcon,
  PlusIcon,
  Settings2Icon,
  Trash2Icon,
} from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { client } from "../lib/orpc";
import { BotAvatar } from "./bot-avatar";
import { BotCreateDialog } from "./bot-create-dialog";
import { BotDeleteDialog } from "./bot-delete-dialog";
import type { DeletableBot } from "./bot-delete-dialog";
import { BotSessions } from "./bot-sessions";
import { SidebarRowMenu } from "./sidebar-row-menu";

type BotItemProps = {
  bot: BotSummary;
  onConfigure: () => void;
  onDelete: () => void;
};

function BotItem({ bot, onConfigure, onDelete }: BotItemProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [open, setOpen] = useState(bot.isDefault);

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      render={<SidebarMenuItem />}
    >
      <div className="group/item relative flex items-center">
        <CollapsibleTrigger
          render={
            <SidebarMenuButton className="cursor-pointer pr-14 group-has-data-[sidebar=menu-action]/menu-item:pr-14 transition-colors duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none" />
          }
        >
          <BotAvatar
            avatarPath={bot.avatarPath}
            botId={bot.id}
            name={bot.name}
            size="sm"
            version={bot.updatedAt}
          />
          <span className="truncate font-medium">{bot.name}</span>
        </CollapsibleTrigger>
        <Tooltip>
          <TooltipTrigger
            render={
              <SidebarMenuAction
                aria-label={t("bots.newSession")}
                className="right-8 opacity-0 pointer-events-none after:inset-0 group-focus-within/item:pointer-events-auto group-focus-within/item:opacity-100 [@media(hover:hover)]:group-hover/item:pointer-events-auto [@media(hover:hover)]:group-hover/item:opacity-100 [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100"
                onClick={() => {
                  setOpen(true);
                  void navigate({
                    to: "/sessions/$sessionId",
                    params: { sessionId: generateSessionId() },
                    search: { botId: bot.id },
                  });
                }}
              />
            }
          >
            <PlusIcon />
          </TooltipTrigger>
          <TooltipContent side="bottom">{t("bots.newSession")}</TooltipContent>
        </Tooltip>
        <SidebarRowMenu label={t("bots.actions.menu")}>
          <DropdownMenuItem onClick={onConfigure}>
            <Settings2Icon />
            {t("bots.actions.configure")}
          </DropdownMenuItem>
          {bot.isDefault ? null : (
            <DropdownMenuItem variant="destructive" onClick={onDelete}>
              <Trash2Icon />
              {t("bots.actions.delete")}
            </DropdownMenuItem>
          )}
        </SidebarRowMenu>
      </div>
      <CollapsibleContent>
        <BotSessions botId={bot.id} />
      </CollapsibleContent>
    </Collapsible>
  );
}

/** Primary expanding Bot sidebar group with pinned Default Bot and per-Bot sessions. */
export function NavBots() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [createOpen, setCreateOpen] = useState(false);
  const [deletingBot, setDeletingBot] = useState<DeletableBot | null>(null);

  const { data } = useQuery({
    queryKey: ["list_bots"],
    queryFn: () => client.bot.list(),
  });

  const bots = data?.bots ?? [];

  return (
    <>
      <Collapsible
        defaultOpen
        render={
          <SidebarGroup className="group/bots group-data-[collapsible=icon]:hidden data-open:flex-1 data-open:min-h-0 py-0" />
        }
      >
        <div className="group/label relative flex items-center">
          <CollapsibleTrigger
            nativeButton={false}
            render={
              <SidebarGroupLabel className="min-w-0 flex-1 cursor-pointer items-center pr-8 [&>svg]:-rotate-90 [&>svg]:opacity-0 [&>svg]:transition-[transform,opacity] [&>svg]:duration-150 [&>svg]:ease-[cubic-bezier(0.23,1,0.32,1)] data-panel-open:[&>svg]:rotate-0 group-hover/label:[&>svg]:opacity-100 focus-visible:[&>svg]:opacity-100 font-normal motion-reduce:[&>svg]:transition-none" />
            }
          >
            <span className="truncate">{t("bots.title")}</span>
            <ChevronDownIcon className="ml-1" />
          </CollapsibleTrigger>
          <Tooltip>
            <TooltipTrigger
              render={
                <SidebarMenuAction
                  aria-label={t("bots.create")}
                  onClick={() => {
                    setCreateOpen(true);
                  }}
                />
              }
            >
              <PlusIcon />
            </TooltipTrigger>
            <TooltipContent side="bottom">{t("bots.create")}</TooltipContent>
          </Tooltip>
        </div>
        <CollapsibleContent className="min-h-0 data-open:flex data-open:flex-1 data-open:flex-col">
          <SidebarGroupContent className="scroll-fade scrollbar-none min-h-0 flex-1 overflow-y-auto">
            <SidebarMenu>
              {bots.map((item) => (
                <BotItem
                  key={item.id}
                  bot={item}
                  onConfigure={() => {
                    void navigate({
                      to: "/bots/$botId",
                      params: { botId: item.id },
                    });
                  }}
                  onDelete={() => {
                    setDeletingBot({ id: item.id, name: item.name });
                  }}
                />
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </CollapsibleContent>
      </Collapsible>
      <BotCreateDialog open={createOpen} onOpenChange={setCreateOpen} />
      <BotDeleteDialog bot={deletingBot} onOpenChange={setDeletingBot} />
    </>
  );
}
