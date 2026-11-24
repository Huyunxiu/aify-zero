import { useQuery } from "@tanstack/react-query";
import { BOT_GLOBAL_SKILLS_MODES } from "@workspace/agent-client";
import type { BotGlobalSkillsMode } from "@workspace/agent-client";
import { Button } from "@workspace/ui/components/button";
import { Checkbox } from "@workspace/ui/components/checkbox";
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@workspace/ui/components/segmented-control";
import { toastManager } from "@workspace/ui/components/toast";
import { openLocalPath } from "@workspace/ui/lib/desktop";
import { client } from "@workspace/ui/lib/orpc";
import { FolderOpenIcon, RefreshCwIcon } from "lucide-react";
import { Fragment } from "react";
import { useTranslation } from "react-i18next";

import {
  SettingGroup,
  SettingGroupHeader,
  SettingGroupTitle,
  SettingItem,
  SettingItemActions,
  SettingItemContent,
  SettingItemDescription,
  SettingItemTitle,
  SettingSeparator,
} from "../settings/setting-frame";
import { useBotSettings } from "./bot-settings-context";

export function BotSkillsSection() {
  const { bot, isSaving, onUpdate } = useBotSettings();
  const { t } = useTranslation();

  const skillsQuery = useQuery({
    queryKey: ["bot-skills", bot.id],
    queryFn: async () => await client.bot.listSkills({ botId: bot.id }),
  });

  const botSkills = skillsQuery.data?.botSkills ?? [];
  const globalSkills = skillsQuery.data?.globalSkills ?? [];
  const skillsDir = skillsQuery.data?.skillsDir ?? bot.skillsDir;

  const selectedSet = new Set(bot.skills.globalNames);

  const setGlobalMode = (mode: BotGlobalSkillsMode) => {
    void onUpdate({
      skills: { ...bot.skills, globalMode: mode },
    });
  };

  const toggleGlobalSkill = (name: string, checked: boolean) => {
    const next = new Set(bot.skills.globalNames);
    if (checked) {
      next.add(name);
    } else {
      next.delete(name);
    }
    void onUpdate({
      skills: {
        ...bot.skills,
        globalMode: "selected",
        globalNames: [...next].toSorted(),
      },
    });
  };

  const openSkillsFolder = async () => {
    const outcome = await openLocalPath(skillsDir);
    if (outcome === "copied") {
      toastManager.add({
        title: t("bots.paths.copied"),
        description: skillsDir,
      });
    }
  };

  return (
    <div className="mx-auto flex w-2xl flex-col gap-6">
      <div>
        <SettingGroupHeader>
          <SettingGroupTitle>{t("bots.sections.skills")}</SettingGroupTitle>
        </SettingGroupHeader>

        <SettingGroup>
          <SettingItem variant="muted">
            <SettingItemContent>
              <SettingItemTitle>
                {t("bots.skills.globalTitle")}
              </SettingItemTitle>
            </SettingItemContent>
            <SettingItemActions>
              <SegmentedControl size="sm">
                {BOT_GLOBAL_SKILLS_MODES.map((mode) => (
                  <SegmentedControlItem
                    key={mode}
                    aria-pressed={bot.skills.globalMode === mode}
                    data-checked={
                      bot.skills.globalMode === mode ? "" : undefined
                    }
                    disabled={isSaving}
                    onClick={() => {
                      setGlobalMode(mode);
                    }}
                  >
                    {t(`bots.skills.modes.${mode}`)}
                  </SegmentedControlItem>
                ))}
              </SegmentedControl>
            </SettingItemActions>
          </SettingItem>

          {bot.skills.globalMode === "selected" ? (
            <>
              <SettingSeparator />
              {globalSkills.length === 0 ? (
                <div className="flex h-16 items-center justify-center text-muted-foreground text-sm">
                  {t("bots.skills.noGlobalSkills")}
                </div>
              ) : (
                globalSkills.map((skill, index) => (
                  <Fragment key={skill.name}>
                    {index > 0 ? <SettingSeparator /> : null}
                    <SettingItem variant="muted">
                      <SettingItemContent className="min-w-0">
                        <SettingItemTitle>{skill.name}</SettingItemTitle>
                        {skill.description ? (
                          <SettingItemDescription>
                            {skill.description}
                          </SettingItemDescription>
                        ) : null}
                      </SettingItemContent>
                      <SettingItemActions>
                        <Checkbox
                          aria-label={skill.name}
                          checked={selectedSet.has(skill.name)}
                          disabled={isSaving}
                          onCheckedChange={(checked) => {
                            toggleGlobalSkill(skill.name, checked);
                          }}
                        />
                      </SettingItemActions>
                    </SettingItem>
                  </Fragment>
                ))
              )}
            </>
          ) : null}
        </SettingGroup>
      </div>

      <div>
        <SettingGroupHeader className="flex-row items-center justify-between">
          <SettingGroupTitle className="text-base">
            {t("bots.skills.privateTitle")}
          </SettingGroupTitle>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              loading={skillsQuery.isFetching}
              onClick={() => {
                void skillsQuery.refetch();
              }}
            >
              <RefreshCwIcon />
              {t("bots.skills.refresh")}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                void openSkillsFolder();
              }}
            >
              <FolderOpenIcon />
              {t("bots.paths.openFolder")}
            </Button>
          </div>
        </SettingGroupHeader>

        <SettingGroup>
          {botSkills.length === 0 ? (
            <div className="flex min-h-20 flex-col items-center justify-center gap-1 px-4 py-3 text-center text-muted-foreground text-sm">
              <span>{t("bots.skills.noPrivateSkills")}</span>
              <span className="font-mono text-xs">{skillsDir}</span>
            </div>
          ) : (
            botSkills.map((skill, index) => (
              <Fragment key={skill.location}>
                {index > 0 ? <SettingSeparator /> : null}
                <SettingItem variant="muted">
                  <SettingItemContent className="min-w-0">
                    <SettingItemTitle>{skill.name}</SettingItemTitle>
                    {skill.description ? (
                      <SettingItemDescription>
                        {skill.description}
                      </SettingItemDescription>
                    ) : null}
                  </SettingItemContent>
                </SettingItem>
              </Fragment>
            ))
          )}
        </SettingGroup>
      </div>
    </div>
  );
}
