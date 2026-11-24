import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxTrigger,
} from "../components/combobox";
import { FolderIcon } from "../components/folder-icon";
import type { ProjectSummary } from "../components/project-dialog";
import { cn } from "../lib/utils";
import { PromptInputButton } from "./prompt-input";

/**
 * The item a combobox needs: a project's identity plus the directory it is
 * matched on. The directory is searched but never displayed.
 */
type ProjectOption = {
  id: string;
  name: string;
  dir: string;
};

/** The "no project" row. A session without a project runs in the default dir. */
const NO_PROJECT_ID = "";

export type ProjectSelectProps = {
  projects: ProjectSummary[];
  projectId: string | undefined;
  onProjectChange: (projectId: string | undefined) => void;
  /**
   * A session keeps the project it was created in: the row is written once,
   * and every later turn has to run in the same directories. A started session
   * can still open and search the list, but cannot change the value.
   */
  locked?: boolean;
};

/**
 * Composer-level project picker.
 *
 * The project is optional — a session with none runs in the default project —
 * so the list starts with a "no project" row rather than forcing a choice. The
 * input inside the popup filters on both the name and the primary directory.
 */
export function ProjectSelect({
  projects,
  projectId,
  onProjectChange,
  locked = false,
}: ProjectSelectProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  const noProject = useMemo<ProjectOption>(
    () => ({ id: NO_PROJECT_ID, name: t("projects.none"), dir: "" }),
    [t]
  );

  const items = useMemo<ProjectOption[]>(
    () => [
      noProject,
      ...projects.map((project) => ({
        id: project.id,
        name: project.name,
        dir: project.primaryDir,
      })),
    ],
    [noProject, projects]
  );

  // Read the value out of `items` every render: Base UI compares selected
  // values by identity, and an item from the same array always matches.
  const value =
    items.find((item) => item.id === (projectId ?? NO_PROJECT_ID)) ?? noProject;
  const isNone = value.id === NO_PROJECT_ID;

  return (
    <Combobox
      filter={(item: ProjectOption, query: string) => {
        const needle = query.trim().toLowerCase();
        return (
          item.name.toLowerCase().includes(needle) ||
          item.dir.toLowerCase().includes(needle)
        );
      }}
      itemToStringLabel={(item) => item.name}
      items={items}
      onOpenChange={setOpen}
      onValueChange={(item) => {
        if (!locked) {
          onProjectChange(item?.id || undefined);
        }
      }}
      open={open}
      value={value}
    >
      <ComboboxTrigger
        render={
          <PromptInputButton
            className={cn(
              "max-w-44",
              isNone && "text-muted-foreground",
              locked && "opacity-60"
            )}
            title={locked ? t("projects.locked") : undefined}
          />
        }
        showChevron={false}
      >
        <FolderIcon open={open} size={16} />
        <span className="min-w-0 truncate">{value.name}</span>
      </ComboboxTrigger>
      <ComboboxContent className="w-72">
        {locked ? (
          <p className="border-b px-3 py-2 text-muted-foreground text-xs">
            {t("projects.locked")}
          </p>
        ) : null}
        <ComboboxInput placeholder={t("projects.search")} showTrigger={false} />
        <ComboboxEmpty>{t("projects.noResults")}</ComboboxEmpty>
        <ComboboxList>
          {(item: ProjectOption) => (
            <ComboboxItem
              disabled={locked}
              key={item.id || "none"}
              value={item}
            >
              <span
                className={cn("truncate", !item.id && "text-muted-foreground")}
              >
                {item.name}
              </span>
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}
