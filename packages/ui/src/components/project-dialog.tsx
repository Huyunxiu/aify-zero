import { useMutation, useQueryClient } from "@tanstack/react-query";
import { getErrorMessage } from "@workspace/shared/errors";
import { Badge } from "@workspace/ui/components/badge";
import { Button } from "@workspace/ui/components/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@workspace/ui/components/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu";
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@workspace/ui/components/field";
import { Input } from "@workspace/ui/components/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@workspace/ui/components/input-group";
import { EllipsisIcon, PlusIcon } from "lucide-react";
import { nanoid } from "nanoid";
import type { FormEvent } from "react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { client } from "../lib/orpc";
import { FolderIcon } from "./folder-icon";

type DirRow = {
  id: string;
  value: string;
};

type FieldErrors = {
  name?: string;
  /** 目录错误按行的 id 记，增删行不会把报错串到别的行上。 */
  dirs: Record<string, string | undefined>;
};

const EMPTY_ERRORS: FieldErrors = { dirs: {} };

/** POSIX、Windows 盘符和 UNC 路径都算绝对路径，和服务端 `isAbsolute` 对齐。 */
function isAbsolutePath(value: string) {
  return /^([A-Za-z]:[\\/]|[\\/])/.test(value);
}

/** 路径的最后一段，用来给没填名称的项目起名。 */
function basenameFromPath(value: string) {
  const trimmed = value.trim().replace(/[\\/]+$/, "");
  return trimmed.slice(
    Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\")) + 1
  );
}

/** 比较目录用：去掉尾部多余的分隔符，根目录保持原样。 */
function comparableDir(value: string) {
  const trimmed = value.trim();
  if (trimmed === "/" || trimmed === "\\" || /^[A-Za-z]:[\\/]$/.test(trimmed)) {
    return trimmed;
  }
  return trimmed.replace(/[\\/]+$/, "");
}

export type ProjectSummary = {
  id: string;
  name: string;
  primaryDir: string;
  additionalDirs: string[];
};

type ProjectDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 传了就是编辑已有项目，否则是新建。 */
  project?: ProjectSummary | null;
};

/**
 * 新建或编辑项目。项目把 agent 的工作目录固定下来（见 `getProjectDirs`）：
 * 列表里第一行是主目录（agent 的工作根），其余目录只能以绝对路径访问。每行
 * 的菜单可以把它设为主目录（这一行会排到最前面），或者删除它。
 *
 * 目录至少保留一行，所以只剩一行时删除是禁用的。新建时名称留空会用主目录
 * 的末级目录名兜底；路径本身仍然必须是绝对路径，同一个目录只能属于一个项目。
 */
export function ProjectDialog({
  open,
  onOpenChange,
  project,
}: ProjectDialogProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [name, setName] = useState(project?.name ?? "");
  // 用户自己动过名称之后，就不再跟着主目录自动改写；编辑已有项目时同理。
  const [nameEdited, setNameEdited] = useState(Boolean(project));
  const [dirs, setDirs] = useState<DirRow[]>(() =>
    project
      ? [project.primaryDir, ...project.additionalDirs].map((value) => ({
          id: nanoid(),
          value,
        }))
      : [{ id: nanoid(), value: "" }]
  );
  const [errors, setErrors] = useState<FieldErrors>(EMPTY_ERRORS);

  const saveProjectMutation = useMutation({
    mutationFn: async (input: {
      name: string;
      primaryDir: string;
      additionalDirs: string[];
    }) =>
      project
        ? await client.project.update({ projectId: project.id, ...input })
        : await client.project.create(input),
    onSuccess: async () => {
      // 侧边栏和其它读项目列表的地方共用这个 key。
      await queryClient.invalidateQueries({ queryKey: ["list_projects"] });
      onOpenChange(false);
    },
  });

  function clearError(key: "name") {
    setErrors((previous) =>
      previous[key] ? { ...previous, [key]: undefined } : previous
    );
  }

  function clearDirError(id: string) {
    setErrors((previous) => {
      if (!previous.dirs[id]) {
        return previous;
      }

      const dirs = { ...previous.dirs };
      delete dirs[id];
      return { ...previous, dirs };
    });
  }

  function handleDirChange(id: string, value: string) {
    setDirs((previous) =>
      previous.map((dir) => (dir.id === id ? { ...dir, value } : dir))
    );
    clearDirError(id);

    // 名称没被手动改过时跟着主目录（第一行）走，省得用户再想一个名字。
    if (!nameEdited && dirs[0]?.id === id) {
      const derivedName = basenameFromPath(value);
      setName(derivedName);
      if (derivedName) {
        clearError("name");
      }
    }
  }

  function addDir() {
    setDirs((previous) => [...previous, { id: nanoid(), value: "" }]);
  }

  /** 把某一行设为主目录：它排到最前面，`primaryDir` 永远是第一行。 */
  function promoteToPrimary(id: string) {
    const index = dirs.findIndex((dir) => dir.id === id);
    const row = dirs[index];
    if (!row || index <= 0) {
      return;
    }

    const remaining = dirs.filter((dir) => dir.id !== id);
    setDirs([row, ...remaining]);

    // 名称没被手动改过时，跟着新的主目录走。
    if (!nameEdited) {
      const derivedName = basenameFromPath(row.value);
      setName(derivedName);
      if (derivedName) {
        clearError("name");
      }
    }
  }

  function removeDir(id: string) {
    // 至少要留一个目录；按钮已经禁用，这里再兜一次底。
    if (dirs.length <= 1) {
      return;
    }

    const remaining = dirs.filter((dir) => dir.id !== id);
    setDirs(remaining);
    clearDirError(id);

    // 删掉的是主目录时，补位上来的那一行就是新的主目录，名称跟着它走。
    if (!nameEdited && dirs[0]?.id === id) {
      const derivedName = basenameFromPath(remaining[0]?.value ?? "");
      setName(derivedName);
      if (derivedName) {
        clearError("name");
      }
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saveProjectMutation.isPending) {
      return;
    }

    const trimmedName = name.trim();
    const [primaryRow, ...otherRows] = dirs;
    const trimmedDir = primaryRow?.value.trim() ?? "";
    // 名称留空时用主目录的末级目录名；两者都空才会轮到必填报错。
    const resolvedName = trimmedName || basenameFromPath(trimmedDir);
    const nextErrors: FieldErrors = { dirs: {} };

    if (!resolvedName) {
      nextErrors.name = t("projects.dialog.nameRequired");
    }
    if (primaryRow) {
      if (!trimmedDir) {
        nextErrors.dirs[primaryRow.id] = t(
          "projects.dialog.directoryRequired"
        );
      } else if (!isAbsolutePath(trimmedDir)) {
        // 服务端也会拒绝，但那里的报错是通用的校验错误，这里先给出字段级的提示。
        nextErrors.dirs[primaryRow.id] = t(
          "projects.dialog.directoryAbsolute"
        );
      }
    }

    const additionalDirs: string[] = [];
    const primaryKey = comparableDir(trimmedDir);
    const seenDirs = new Set<string>([primaryKey]);
    for (const row of otherRows) {
      const value = row.value.trim();
      if (!value) {
        continue;
      }
      if (!isAbsolutePath(value)) {
        nextErrors.dirs[row.id] = t("projects.dialog.directoryAbsolute");
        continue;
      }
      const key = comparableDir(value);
      if (key === primaryKey) {
        nextErrors.dirs[row.id] = t("projects.dialog.directorySameAsPrimary");
        continue;
      }
      if (seenDirs.has(key)) {
        nextErrors.dirs[row.id] = t("projects.dialog.directoryDuplicate");
        continue;
      }
      seenDirs.add(key);
      additionalDirs.push(value);
    }

    setErrors(nextErrors);
    if (
      nextErrors.name ||
      Object.keys(nextErrors.dirs).length > 0 ||
      !primaryRow
    ) {
      return;
    }

    saveProjectMutation.mutate({
      name: resolvedName,
      primaryDir: trimmedDir,
      additionalDirs,
    });
  }

  const canRemoveDir = dirs.length > 1;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FolderIcon open={Boolean(project)} size={20} />
            {project
              ? t("projects.dialog.editTitle")
              : t("projects.dialog.title")}
          </DialogTitle>
          <DialogDescription>
            {t("projects.dialog.description")}
          </DialogDescription>
        </DialogHeader>

        <div className="scroll-fade -mx-4 max-h-[60vh] overflow-y-auto px-4">
          <form id="project-form" onSubmit={handleSubmit} noValidate>
            <FieldGroup>
              <Field data-invalid={Boolean(errors.name)}>
                <FieldLabel htmlFor="project-name">
                  {t("projects.dialog.name")}
                </FieldLabel>
                <Input
                  id="project-name"
                  name="name"
                  value={name}
                  onChange={(event) => {
                    setName(event.target.value);
                    setNameEdited(true);
                    clearError("name");
                  }}
                  placeholder={t("projects.dialog.namePlaceholder")}
                  aria-invalid={Boolean(errors.name)}
                  autoComplete="off"
                />
                {errors.name ? (
                  <FieldError errors={[{ message: errors.name }]} />
                ) : null}
              </Field>

              <Field data-invalid={Object.keys(errors.dirs).length > 0}>
                <FieldLabel htmlFor={`project-dir-${dirs[0]?.id ?? "primary"}`}>
                  {t("projects.dialog.directory")}
                </FieldLabel>
                {dirs.map((dir, index) => (
                  <div key={dir.id} className="flex flex-col gap-1">
                    <InputGroup>
                      <InputGroupInput
                        id={`project-dir-${dir.id}`}
                        aria-label={
                          index === 0
                            ? undefined
                            : `${t("projects.dialog.directory")} ${index + 1}`
                        }
                        value={dir.value}
                        placeholder={t("projects.dialog.directoryPlaceholder")}
                        onChange={(event) => {
                          handleDirChange(dir.id, event.target.value);
                        }}
                        aria-invalid={Boolean(errors.dirs[dir.id])}
                        autoComplete="off"
                        spellCheck={false}
                      />
                      <InputGroupAddon align="inline-end" className="py-0">
                        {index === 0 ? (
                          <Badge variant="secondary">
                            {t("projects.dialog.primaryBadge")}
                          </Badge>
                        ) : null}
                        <DropdownMenu>
                          <DropdownMenuTrigger
                            render={
                              <InputGroupButton
                                aria-label={t(
                                  "projects.dialog.directoryActions"
                                )}
                                size="icon-xs"
                                variant="ghost"
                              />
                            }
                          >
                            <EllipsisIcon />
                          </DropdownMenuTrigger>
                          <DropdownMenuContent
                            align="end"
                            alignOffset={-4}
                            sideOffset={8}
                            className="w-auto min-w-50"
                          >
                            <DropdownMenuItem
                              disabled={index === 0}
                              onClick={() => {
                                promoteToPrimary(dir.id);
                              }}
                            >
                              {t("projects.dialog.setPrimaryDir")}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              variant="destructive"
                              disabled={!canRemoveDir}
                              onClick={() => {
                                removeDir(dir.id);
                              }}
                            >
                              {t("projects.dialog.removeDirectory")}
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </InputGroupAddon>
                    </InputGroup>
                    {errors.dirs[dir.id] ? (
                      <FieldError
                        errors={[
                          {
                            message: errors.dirs[dir.id],
                          },
                        ]}
                      />
                    ) : null}
                  </div>
                ))}

                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="w-fit"
                  onClick={addDir}
                >
                  <PlusIcon data-icon="inline-start" />
                  {t("projects.dialog.addDirectory")}
                </Button>
              </Field>
            </FieldGroup>
          </form>
        </div>

        {saveProjectMutation.isError ? (
          <p className="text-destructive text-sm" role="alert">
            {getErrorMessage(saveProjectMutation.error)}
          </p>
        ) : null}

        <DialogFooter>
          <DialogClose
            render={
              <Button
                type="button"
                variant="outline"
                disabled={saveProjectMutation.isPending}
              />
            }
          >
            {t("projects.dialog.cancel")}
          </DialogClose>
          <Button
            type="submit"
            form="project-form"
            loading={saveProjectMutation.isPending}
            disabled={saveProjectMutation.isPending}
          >
            {project ? t("projects.dialog.update") : t("projects.dialog.submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
