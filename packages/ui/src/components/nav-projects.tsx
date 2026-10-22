import { useQuery } from "@tanstack/react-query";
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
import { ChevronDownIcon, PencilIcon, PlusIcon } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { client } from "../lib/orpc";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./collapsible";
import { FolderIcon } from "./folder-icon";
import { ProjectDialog, type ProjectSummary } from "./project-dialog";
import { ProjectSessions } from "./project-sessions";

type ProjectItemProps = {
  project: ProjectSummary;
  onEdit: () => void;
};

/** 一个项目行：点它展开项目内的会话，铅笔按钮进编辑。 */
function ProjectItem({ project, onEdit }: ProjectItemProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      render={<SidebarMenuItem />}
    >
      <CollapsibleTrigger
        render={
          <SidebarMenuButton className="group/folder-row cursor-pointer pr-8" />
        }
      >
        <FolderIcon open={open} size={18} />
        <span className="truncate">{project.name}</span>
      </CollapsibleTrigger>
      <SidebarMenuAction
        aria-label={t("projects.edit")}
        showOnHover
        onClick={onEdit}
      >
        <PencilIcon />
      </SidebarMenuAction>
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
        <SidebarGroup className="group/projects group-data-[collapsible=icon]:hidden" />
      }
    >
      {/* 标题行自己是一个 hover 域，新建按钮只在鼠标停在标题上时出现。 */}
      <div className="group/label relative flex items-center">
        <CollapsibleTrigger
          nativeButton={false}
          render={
            <SidebarGroupLabel className="min-w-0 flex-1 cursor-pointer items-center pr-8 [&>svg]:-rotate-90 [&>svg]:opacity-0 [&>svg]:transition-all data-panel-open:[&>svg]:rotate-0 group-hover/projects:[&>svg]:opacity-100 focus-visible:[&>svg]:opacity-100" />
          }
        >
          <span className="truncate">{t("projects.title")}</span>
          <ChevronDownIcon className="ml-1" />
        </CollapsibleTrigger>
        <Button
          aria-label={t("projects.create")}
          onClick={openCreateDialog}
          size="icon-sm"
          variant="ghost"
        >
          <PlusIcon />
        </Button>
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
