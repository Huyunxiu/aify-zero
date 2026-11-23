import { useQuery } from "@tanstack/react-query";
import { Badge } from "@workspace/ui/components/badge";
import { BotDeleteDialog } from "@workspace/ui/components/bot-delete-dialog";
import type { DeletableBot } from "@workspace/ui/components/bot-delete-dialog";
import { Button } from "@workspace/ui/components/button";
import { CopyButton } from "@workspace/ui/components/copy-button";
import { Input } from "@workspace/ui/components/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select";
import { toastManager } from "@workspace/ui/components/toast";
import { openLocalPath } from "@workspace/ui/lib/desktop";
import { client } from "@workspace/ui/lib/orpc";
import { FolderOpenIcon, Trash2Icon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  SettingGroup,
  SettingGroupHeader,
  SettingGroupTitle,
  SettingItem,
  SettingItemActions,
  SettingItemContent,
  SettingItemTitle,
  SettingSeparator,
} from "../settings/setting-frame";
import type { BotSectionProps } from "./types";

const NO_PROJECT_VALUE = "__none__";

export function BotGeneralSection({
  bot,
  isSaving,
  onUpdate,
}: BotSectionProps) {
  const { t } = useTranslation();
  const [name, setName] = useState(bot.name);
  const [avatar, setAvatar] = useState(bot.avatar ?? "");
  const [description, setDescription] = useState(bot.description ?? "");
  const [deletingBot, setDeletingBot] = useState<DeletableBot | null>(null);

  useEffect(() => {
    setName(bot.name);
    setAvatar(bot.avatar ?? "");
    setDescription(bot.description ?? "");
  }, [bot.id, bot.name, bot.avatar, bot.description]);

  const projectsQuery = useQuery({
    queryKey: ["list_projects"],
    queryFn: () => client.project.list(),
  });
  const projectsData = projectsQuery.data?.projects;
  const projectItems = useMemo(
    () => [
      { value: NO_PROJECT_VALUE, label: t("projects.none") },
      ...(projectsData ?? []).map((project) => ({
        value: project.id,
        label: project.name,
      })),
    ],
    [projectsData, t]
  );
  const projects = projectsData ?? [];

  const trimmedName = name.trim();
  const trimmedAvatar = avatar.trim();
  const trimmedDescription = description.trim();
  const identityDirty =
    trimmedName !== bot.name ||
    trimmedAvatar !== (bot.avatar ?? "") ||
    trimmedDescription !== (bot.description ?? "");

  const saveIdentity = async () => {
    if (!trimmedName || isSaving || !identityDirty) {
      return;
    }
    await onUpdate({
      name: trimmedName,
      avatar: trimmedAvatar === "" ? null : trimmedAvatar,
      description: trimmedDescription === "" ? null : trimmedDescription,
    });
  };

  const handleOpenFolder = async (targetPath: string) => {
    const outcome = await openLocalPath(targetPath);
    if (outcome === "copied") {
      toastManager.add({
        title: t("bots.paths.copied"),
        description: targetPath,
      });
    }
  };

  return (
    <div className="mx-auto flex w-2xl flex-col gap-6">
      <div>
        <SettingGroupHeader className="flex-row items-center justify-between">
          <div className="flex items-center gap-2">
            <SettingGroupTitle>{t("bots.sections.general")}</SettingGroupTitle>
            {bot.isDefault ? (
              <Badge variant="secondary">{t("bots.defaultBadge")}</Badge>
            ) : null}
          </div>
          {identityDirty ? (
            <Button
              size="sm"
              loading={isSaving}
              disabled={isSaving || trimmedName.length === 0}
              onClick={() => {
                void saveIdentity();
              }}
            >
              {t("bots.actions.save")}
            </Button>
          ) : null}
        </SettingGroupHeader>

        <SettingGroup>
          <SettingItem variant="muted">
            <SettingItemContent>
              <SettingItemTitle>{t("bots.fields.avatar")}</SettingItemTitle>
            </SettingItemContent>
            <SettingItemActions>
              <Input
                value={avatar}
                maxLength={8}
                placeholder="🤖"
                aria-label={t("bots.fields.avatar")}
                className="w-16 text-center shadow-xs"
                onChange={(event) => {
                  setAvatar(event.target.value);
                }}
              />
            </SettingItemActions>
          </SettingItem>
          <SettingSeparator />
          <SettingItem variant="muted">
            <SettingItemContent>
              <SettingItemTitle>{t("bots.fields.name")}</SettingItemTitle>
            </SettingItemContent>
            <SettingItemActions>
              <Input
                value={name}
                aria-label={t("bots.fields.name")}
                className="w-64 shadow-xs"
                onChange={(event) => {
                  setName(event.target.value);
                }}
              />
            </SettingItemActions>
          </SettingItem>
          <SettingSeparator />
          <SettingItem variant="muted">
            <SettingItemContent>
              <SettingItemTitle>
                {t("bots.fields.description")}
              </SettingItemTitle>
            </SettingItemContent>
            <SettingItemActions>
              <Input
                value={description}
                aria-label={t("bots.fields.description")}
                placeholder={t("bots.fields.descriptionPlaceholder")}
                className="w-64 shadow-xs"
                onChange={(event) => {
                  setDescription(event.target.value);
                }}
              />
            </SettingItemActions>
          </SettingItem>
          <SettingSeparator />
          <SettingItem variant="muted">
            <SettingItemContent>
              <SettingItemTitle>
                {t("bots.fields.defaultProject")}
              </SettingItemTitle>
            </SettingItemContent>
            <SettingItemActions>
              <Select
                items={projectItems}
                value={bot.defaultProjectId ?? NO_PROJECT_VALUE}
                disabled={isSaving}
                onValueChange={(value) => {
                  void onUpdate({
                    defaultProjectId:
                      !value || value === NO_PROJECT_VALUE ? null : value,
                  });
                }}
              >
                <SelectTrigger className="w-56 border-none shadow-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_PROJECT_VALUE}>
                    {t("projects.none")}
                  </SelectItem>
                  {projects.map((project) => (
                    <SelectItem key={project.id} value={project.id}>
                      {project.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </SettingItemActions>
          </SettingItem>
        </SettingGroup>
      </div>

      <div>
        <SettingGroupHeader>
          <SettingGroupTitle className="text-base">
            {t("bots.paths.title")}
          </SettingGroupTitle>
        </SettingGroupHeader>
        <SettingGroup>
          <SettingItem variant="muted">
            <SettingItemContent className="min-w-0">
              <SettingItemTitle>{t("bots.paths.home")}</SettingItemTitle>
              <span className="truncate font-mono text-muted-foreground text-xs">
                {bot.homeDir}
              </span>
            </SettingItemContent>
            <SettingItemActions>
              <Button
                type="button"
                variant="outline"
                size="icon"
                aria-label={t("bots.paths.openFolder")}
                onClick={() => {
                  void handleOpenFolder(bot.homeDir);
                }}
              >
                <FolderOpenIcon />
              </Button>
              <CopyButton label={t("bots.paths.copy")} message={bot.homeDir} />
            </SettingItemActions>
          </SettingItem>
          <SettingSeparator />
          <SettingItem variant="muted">
            <SettingItemContent className="min-w-0">
              <SettingItemTitle>{t("bots.paths.workspace")}</SettingItemTitle>
              <span className="truncate font-mono text-muted-foreground text-xs">
                {bot.workspaceDir}
              </span>
            </SettingItemContent>
            <SettingItemActions>
              <Button
                type="button"
                variant="outline"
                size="icon"
                aria-label={t("bots.paths.openFolder")}
                onClick={() => {
                  void handleOpenFolder(bot.workspaceDir);
                }}
              >
                <FolderOpenIcon />
              </Button>
              <CopyButton
                label={t("bots.paths.copy")}
                message={bot.workspaceDir}
              />
            </SettingItemActions>
          </SettingItem>
        </SettingGroup>
      </div>

      {bot.isDefault ? null : (
        <SettingGroup>
          <SettingItem variant="muted">
            <SettingItemContent>
              <SettingItemTitle>{t("bots.actions.deleteBot")}</SettingItemTitle>
            </SettingItemContent>
            <SettingItemActions>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                onClick={() => {
                  setDeletingBot({
                    id: bot.id,
                    name: bot.name,
                    homeDir: bot.homeDir,
                  });
                }}
              >
                <Trash2Icon />
                {t("bots.actions.delete")}
              </Button>
            </SettingItemActions>
          </SettingItem>
        </SettingGroup>
      )}

      <BotDeleteDialog bot={deletingBot} onOpenChange={setDeletingBot} />
    </div>
  );
}
