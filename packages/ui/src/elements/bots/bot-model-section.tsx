import { useQuery } from "@tanstack/react-query";
import type { BotCompactionOverride } from "@workspace/agent-client";
import { ModelEffort } from "@workspace/shared/constants";
import { Button } from "@workspace/ui/components/button";
import { Input } from "@workspace/ui/components/input";
import { Switch } from "@workspace/ui/components/switch";
import { Textarea } from "@workspace/ui/components/textarea";
import { flattenModels, sameModel } from "@workspace/ui/lib/models";
import { client } from "@workspace/ui/lib/orpc";
import { AlertTriangleIcon, XIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { ModelSelect } from "../model-select";
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

const DEFAULT_OVERRIDE: Required<BotCompactionOverride> = {
  auto: true,
  thresholdRatio: 0.8,
  reserveTokens: 16_384,
  keepRecentTokens: 20_000,
  pruneToolResults: true,
  maxSummaryTokens: 8192,
};

export function BotModelSection({ bot, isSaving, onUpdate }: BotSectionProps) {
  const { t } = useTranslation();
  const [instructions, setInstructions] = useState(bot.instructions ?? "");
  const [compactionDraft, setCompactionDraft] = useState<
    Required<BotCompactionOverride>
  >({
    ...DEFAULT_OVERRIDE,
    ...bot.compaction,
  });

  useEffect(() => {
    setInstructions(bot.instructions ?? "");
  }, [bot.id, bot.instructions]);

  useEffect(() => {
    setCompactionDraft({
      ...DEFAULT_OVERRIDE,
      ...bot.compaction,
    });
  }, [bot.id, bot.compaction]);

  const settingsQuery = useQuery({
    queryKey: ["settings"],
    queryFn: async () => await client.setting.get(),
  });

  const models = useMemo(
    () => flattenModels(settingsQuery.data?.providers ?? []),
    [settingsQuery.data?.providers]
  );

  const missingSavedModel =
    bot.defaultModel !== null &&
    settingsQuery.isSuccess &&
    !models.some((option) =>
      sameModel(option.ref, bot.defaultModel ?? undefined)
    );

  const trimmedInstructions = instructions.trim();
  const instructionsDirty =
    trimmedInstructions !== (bot.instructions?.trim() ?? "");

  const compactionCustom = bot.compaction !== null;
  const compactionDirty =
    compactionCustom &&
    (compactionDraft.auto !== (bot.compaction?.auto ?? DEFAULT_OVERRIDE.auto) ||
      compactionDraft.pruneToolResults !==
        (bot.compaction?.pruneToolResults ??
          DEFAULT_OVERRIDE.pruneToolResults) ||
      compactionDraft.thresholdRatio !==
        (bot.compaction?.thresholdRatio ?? DEFAULT_OVERRIDE.thresholdRatio) ||
      compactionDraft.reserveTokens !==
        (bot.compaction?.reserveTokens ?? DEFAULT_OVERRIDE.reserveTokens) ||
      compactionDraft.keepRecentTokens !==
        (bot.compaction?.keepRecentTokens ??
          DEFAULT_OVERRIDE.keepRecentTokens) ||
      compactionDraft.maxSummaryTokens !==
        (bot.compaction?.maxSummaryTokens ??
          DEFAULT_OVERRIDE.maxSummaryTokens));

  return (
    <div className="mx-auto flex w-2xl flex-col gap-6">
      <div>
        <SettingGroupHeader>
          <SettingGroupTitle>{t("bots.sections.model")}</SettingGroupTitle>
        </SettingGroupHeader>

        {missingSavedModel && bot.defaultModel ? (
          <div
            className="mb-3 flex items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-amber-900 text-xs dark:text-amber-200"
            role="alert"
          >
            <AlertTriangleIcon className="size-4 shrink-0" />
            <span>
              {t("bots.model.missingWarning", {
                model: `${bot.defaultModel.providerId}/${bot.defaultModel.modelId}`,
              })}
            </span>
          </div>
        ) : null}

        <SettingGroup>
          <SettingItem variant="muted">
            <SettingItemContent>
              <SettingItemTitle>
                {t("bots.fields.defaultModel")}
              </SettingItemTitle>
            </SettingItemContent>
            <SettingItemActions>
              <ModelSelect
                models={models}
                model={bot.defaultModel ?? undefined}
                modelEffort={bot.defaultEffort ?? ModelEffort.Default}
                onModelChange={(ref) => {
                  void onUpdate({
                    defaultModel: ref,
                    defaultEffort: bot.defaultEffort ?? ModelEffort.Default,
                  });
                }}
                onModelEffortChange={(effort) => {
                  void onUpdate({ defaultEffort: effort });
                }}
              />
              {bot.defaultModel ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t("bots.model.inheritGlobal")}
                  disabled={isSaving}
                  onClick={() => {
                    void onUpdate({
                      defaultModel: null,
                      defaultEffort: null,
                    });
                  }}
                >
                  <XIcon />
                </Button>
              ) : null}
            </SettingItemActions>
          </SettingItem>
        </SettingGroup>
      </div>

      <div>
        <SettingGroupHeader className="flex-row items-center justify-between">
          <SettingGroupTitle className="text-base">
            {t("bots.model.instructionsTitle")}
          </SettingGroupTitle>
          {instructionsDirty ? (
            <Button
              size="sm"
              loading={isSaving}
              disabled={isSaving}
              onClick={() => {
                void onUpdate({
                  instructions:
                    trimmedInstructions === "" ? null : instructions,
                });
              }}
              className="transition-transform duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] active:scale-[0.97] motion-reduce:transition-none motion-reduce:transform-none"
            >
              {t("bots.actions.save")}
            </Button>
          ) : null}
        </SettingGroupHeader>

        <SettingGroup>
          <div className="p-3">
            <Textarea
              rows={7}
              value={instructions}
              aria-label={t("bots.model.instructionsTitle")}
              placeholder={t("bots.model.instructionsPlaceholder")}
              className="min-h-36 resize-y shadow-xs"
              onChange={(event) => {
                setInstructions(event.target.value);
              }}
            />
          </div>
          <SettingSeparator />
          <SettingItem variant="muted">
            <SettingItemContent>
              <SettingItemTitle>
                {t("bots.model.includeGlobalContext")}
              </SettingItemTitle>
            </SettingItemContent>
            <SettingItemActions>
              <Switch
                aria-label={t("bots.model.includeGlobalContext")}
                checked={bot.includeGlobalContext}
                disabled={isSaving}
                onCheckedChange={(checked) => {
                  void onUpdate({ includeGlobalContext: checked });
                }}
              />
            </SettingItemActions>
          </SettingItem>
        </SettingGroup>
      </div>

      <div>
        <SettingGroupHeader className="flex-row items-center justify-between">
          <SettingGroupTitle className="text-base">
            {t("bots.model.compaction.title")}
          </SettingGroupTitle>
          {compactionDirty ? (
            <Button
              size="sm"
              loading={isSaving}
              disabled={isSaving}
              onClick={() => {
                void onUpdate({ compaction: compactionDraft });
              }}
            >
              {t("bots.actions.save")}
            </Button>
          ) : null}
        </SettingGroupHeader>

        <SettingGroup>
          <SettingItem variant="muted">
            <SettingItemContent>
              <SettingItemTitle>
                {t("bots.model.compaction.override")}
              </SettingItemTitle>
            </SettingItemContent>
            <SettingItemActions>
              <Switch
                aria-label={t("bots.model.compaction.override")}
                checked={compactionCustom}
                disabled={isSaving}
                onCheckedChange={(checked) => {
                  if (checked) {
                    const next = {
                      ...DEFAULT_OVERRIDE,
                      ...settingsQuery.data?.compaction,
                    };
                    setCompactionDraft(next);
                    void onUpdate({ compaction: next });
                  } else {
                    void onUpdate({ compaction: null });
                  }
                }}
              />
            </SettingItemActions>
          </SettingItem>

          {compactionCustom ? (
            <>
              <SettingSeparator />
              <SettingItem variant="muted">
                <SettingItemContent>
                  <SettingItemTitle>
                    {t("bots.model.compaction.auto")}
                  </SettingItemTitle>
                </SettingItemContent>
                <SettingItemActions>
                  <Switch
                    checked={compactionDraft.auto}
                    onCheckedChange={(checked) => {
                      setCompactionDraft((prev) => ({
                        ...prev,
                        auto: checked,
                      }));
                    }}
                  />
                </SettingItemActions>
              </SettingItem>
              <SettingSeparator />
              <SettingItem variant="muted">
                <SettingItemContent>
                  <SettingItemTitle>
                    {t("bots.model.compaction.pruneToolResults")}
                  </SettingItemTitle>
                </SettingItemContent>
                <SettingItemActions>
                  <Switch
                    checked={compactionDraft.pruneToolResults}
                    onCheckedChange={(checked) => {
                      setCompactionDraft((prev) => ({
                        ...prev,
                        pruneToolResults: checked,
                      }));
                    }}
                  />
                </SettingItemActions>
              </SettingItem>
              <SettingSeparator />
              <SettingItem variant="muted">
                <SettingItemContent>
                  <SettingItemTitle>
                    {t("bots.model.compaction.thresholdRatio")}
                  </SettingItemTitle>
                </SettingItemContent>
                <SettingItemActions>
                  <Input
                    type="number"
                    min={0.5}
                    max={0.95}
                    step={0.05}
                    className="w-28 shadow-xs"
                    value={compactionDraft.thresholdRatio}
                    onChange={(event) => {
                      const val = Number(event.target.value);
                      if (!Number.isNaN(val)) {
                        setCompactionDraft((prev) => ({
                          ...prev,
                          thresholdRatio: Math.min(0.95, Math.max(0.5, val)),
                        }));
                      }
                    }}
                  />
                </SettingItemActions>
              </SettingItem>
              <SettingSeparator />
              <SettingItem variant="muted">
                <SettingItemContent>
                  <SettingItemTitle>
                    {t("bots.model.compaction.keepRecentTokens")}
                  </SettingItemTitle>
                </SettingItemContent>
                <SettingItemActions>
                  <Input
                    type="number"
                    min={0}
                    step={1000}
                    className="w-32 shadow-xs"
                    value={compactionDraft.keepRecentTokens}
                    onChange={(event) => {
                      const val = Number(event.target.value);
                      if (!Number.isNaN(val) && val >= 0) {
                        setCompactionDraft((prev) => ({
                          ...prev,
                          keepRecentTokens: Math.floor(val),
                        }));
                      }
                    }}
                  />
                </SettingItemActions>
              </SettingItem>
            </>
          ) : null}
        </SettingGroup>
      </div>
    </div>
  );
}
