import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { generateSessionId } from "@workspace/agent/utils/id-util";
import { Button } from "@workspace/ui/components/button";
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
  ChevronDownIcon,
  FolderPlusIcon,
  PencilIcon,
  PlusIcon,
} from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { client } from "../lib/orpc";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./collapsible";
import { DropdownMenuItem } from "./dropdown-menu";
import { FolderIcon } from "./folder-icon";
import { ProjectDialog, type ProjectSummary } from "./project-dialog";
import { ProjectSessions } from "./project-sessions";
import { SidebarRowMenu } from "./sidebar-row-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip";

type ProjectItemProps = {
  project: ProjectSummary;
  onEdit: () => void;
};

/** 一个项目行：点它展开项目内的会话，右侧悬停出新建会话与设置。 */
function ProjectItem({ project, onEdit }: ProjectItemProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      render={<SidebarMenuItem />}
    >
      {/* 悬停域只圈住项目自己的标题行，会话列表留在外面。
          否则悬停会话会连带展开项目菜单，悬停项目也会展开所有会话菜单。 */}
      <div className="group/item relative flex items-center">
        <CollapsibleTrigger
          render={
            <SidebarMenuButton className="group/folder-row cursor-pointer pr-14 group-has-data-[sidebar=menu-action]/menu-item:pr-14" />
          }
        >
          <FolderIcon open={open} size={18} />
          <span className="truncate">{project.name}</span>
        </CollapsibleTrigger>
        <Tooltip>
          <TooltipTrigger
            render={
              <SidebarMenuAction
                aria-label={t("projects.newSession")}
                className="right-8 opacity-0 pointer-events-none after:inset-0 group-focus-within/item:pointer-events-auto group-focus-within/item:opacity-100 group-hover/item:pointer-events-auto group-hover/item:opacity-100 max-md:pointer-events-auto max-md:opacity-100"
                onClick={() => {
                  // 先展开项目，首条消息落库后新会话就直接出现在它下面。
                  setOpen(true);
                  navigate({
                    to: `/sessions/${generateSessionId()}`,
                    search: { projectId: project.id },
                  });
                }}
              />
            }
          >
            <PlusIcon />
          </TooltipTrigger>
          <TooltipContent side="bottom">{t("projects.newSession")}</TooltipContent>
        </Tooltip>
        <SidebarRowMenu label={t("projects.actions")}>
          <DropdownMenuItem
            onClick={() => {
              onEdit();
            }}
          >
            <PencilIcon />
            {t("projects.edit")}
          </DropdownMenuItem>
        </SidebarRowMenu>
      </div>
      <CollapsibleContent>
        <ProjectSessions projectId={project.id} />
      </CollapsibleContent>
    </Collapsible>
  );
}

export function NavProjects() {
  const { t } = useTranslation();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingProject, setEditingProject] = useState<ProjectSummary | null>(
    null
  );
  // 每次打开都换一个 key，让弹窗按当前项目重新初始化表单。
  const [dialogKey, setDialogKey] = useState(0);

  const { data } = useQuery({
    queryKey: ["list_projects"],
    queryFn: () => client.project.list(),
  });

  function openCreateDialog() {
    setEditingProject(null);
    setDialogKey((key) => key + 1);
    setDialogOpen(true);
  }

  function openEditDialog(project: ProjectSummary) {
    setEditingProject(project);
    setDialogKey((key) => key + 1);
    setDialogOpen(true);
  }

  return (
    <Collapsible
      defaultOpen
      render={
        <SidebarGroup className="group-data-[collapsible=icon]:hidden py-0" />
      }
    >
      {/* 标题行自己是一个 hover 域，新建按钮只在鼠标停在标题上时出现。 */}
      <div className="group/label relative flex items-center">
        <CollapsibleTrigger
          nativeButton={false}
          render={
            <SidebarGroupLabel className="min-w-0 flex-1 cursor-pointer items-center pr-8 [&>svg]:-rotate-90 [&>svg]:opacity-0 [&>svg]:transition-all data-panel-open:[&>svg]:rotate-0 group-hover/label:[&>svg]:opacity-100 focus-visible:[&>svg]:opacity-100 font-normal" />
          }
        >
          <span className="truncate">{t("projects.title")}</span>
          <ChevronDownIcon className="ml-1" />
        </CollapsibleTrigger>
        <Tooltip>
          <TooltipTrigger
            render={
              <SidebarMenuAction
                aria-label={t("projects.create")}
                onClick={openCreateDialog}
              />
            }
          >
            <FolderPlusIcon />
          </TooltipTrigger>
          <TooltipContent side="bottom">{t("projects.create")}</TooltipContent>
        </Tooltip>
      </div>
      <CollapsibleContent>
        <SidebarGroupContent className="scroll-fade scrollbar-none max-h-[40vh] overflow-y-auto">
          <SidebarMenu>
            {data?.projects.map((item) => (
              <ProjectItem
                key={item.id}
                project={item}
                onEdit={() => openEditDialog(item)}
              />
            ))}
          </SidebarMenu>
          {data?.projects.length === 0 ? (
            <p className="px-2 py-1 text-xs text-sidebar-foreground/50">
              {t("projects.empty")}
            </p>
          ) : null}
        </SidebarGroupContent>
      </CollapsibleContent>
      <ProjectDialog
        key={dialogKey}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        project={editingProject}
      />
    </Collapsible>
  );
}
