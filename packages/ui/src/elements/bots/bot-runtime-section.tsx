import { BOT_SANDBOX_ADAPTERS, BOT_TOOL_GROUPS } from "@workspace/agent-client";
import type {
  BotSandboxAdapterChoice,
  BotToolGroup,
} from "@workspace/agent-client";
import { Button } from "@workspace/ui/components/button";
import { Input } from "@workspace/ui/components/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select";
import { Switch } from "@workspace/ui/components/switch";
import { PlusIcon, Trash2Icon } from "lucide-react";
import { Fragment, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { ApprovalPolicySelect } from "../approval-policy-select";
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
import { useBotSettings } from "./bot-settings-context";

function isSandboxAdapterChoice(
  value: string
): value is BotSandboxAdapterChoice {
  return BOT_SANDBOX_ADAPTERS.some((item) => item === value);
}

export function BotRuntimeSection() {
  const { bot, isSaving, onUpdate } = useBotSettings();
  const { t } = useTranslation();
  const [image, setImage] = useState(bot.sandbox.image ?? "");
  const [newEnvKey, setNewEnvKey] = useState("");
  const [newEnvValue, setNewEnvValue] = useState("");

  const adapterItems = useMemo(
    () =>
      BOT_SANDBOX_ADAPTERS.map((adapter) => ({
        value: adapter,
        label: t(`bots.runtime.adapters.${adapter}`),
      })),
    [t]
  );

  useEffect(() => {
    setImage(bot.sandbox.image ?? "");
  }, [bot.id, bot.sandbox.image]);

  const trimmedImage = image.trim();
  const imageDirty = trimmedImage !== (bot.sandbox.image ?? "");

  const toggleToolGroup = (group: BotToolGroup, checked: boolean) => {
    const next = { ...bot.toolGroups, [group]: checked };
    if (group === "shell" && !checked) {
      next.jobs = false;
    }
    void onUpdate({ toolGroups: next });
  };

  const handleAddEnv = async () => {
    const key = newEnvKey.trim();
    if (!key || isSaving) {
      return;
    }
    await onUpdate({ envPatch: { [key]: newEnvValue } });
    setNewEnvKey("");
    setNewEnvValue("");
  };

  return (
    <div className="mx-auto flex w-2xl flex-col gap-6">
      <div>
        <SettingGroupHeader>
          <SettingGroupTitle>{t("bots.runtime.toolsTitle")}</SettingGroupTitle>
        </SettingGroupHeader>

        <SettingGroup>
          {BOT_TOOL_GROUPS.map((group, index) => {
            const disabledByShell = group === "jobs" && !bot.toolGroups.shell;
            const checked = disabledByShell ? false : bot.toolGroups[group];
            return (
              <Fragment key={group}>
                {index > 0 ? <SettingSeparator /> : null}
                <SettingItem variant="muted">
                  <SettingItemContent>
                    <SettingItemTitle>
                      {t(`bots.runtime.tools.${group}`)}
                    </SettingItemTitle>
                  </SettingItemContent>
                  <SettingItemActions>
                    <Switch
                      aria-label={t(`bots.runtime.tools.${group}`)}
                      checked={checked}
                      disabled={isSaving || disabledByShell}
                      onCheckedChange={(nextChecked) => {
                        toggleToolGroup(group, nextChecked);
                      }}
                    />
                  </SettingItemActions>
                </SettingItem>
              </Fragment>
            );
          })}
        </SettingGroup>
      </div>

      <div>
        <SettingGroupHeader>
          <SettingGroupTitle className="text-base">
            {t("bots.runtime.sandboxTitle")}
          </SettingGroupTitle>
        </SettingGroupHeader>

        <SettingGroup>
          <SettingItem variant="muted">
            <SettingItemContent>
              <SettingItemTitle>
                {t("bots.runtime.approvalPolicy")}
              </SettingItemTitle>
            </SettingItemContent>
            <SettingItemActions>
              <ApprovalPolicySelect
                approvalPolicy={bot.defaultApprovalPolicy}
                onApprovalPolicyChange={(policy) => {
                  void onUpdate({ defaultApprovalPolicy: policy });
                }}
              />
            </SettingItemActions>
          </SettingItem>
          <SettingSeparator />
          <SettingItem variant="muted">
            <SettingItemContent>
              <SettingItemTitle>
                {t("bots.runtime.sandboxAdapter")}
              </SettingItemTitle>
            </SettingItemContent>
            <SettingItemActions>
              <Select
                items={adapterItems}
                value={bot.sandbox.adapter}
                disabled={isSaving}
                onValueChange={(value) => {
                  if (!value || !isSandboxAdapterChoice(value)) {
                    return;
                  }
                  void onUpdate({
                    sandbox: { ...bot.sandbox, adapter: value },
                  });
                }}
              >
                <SelectTrigger className="w-48 border-none shadow-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {BOT_SANDBOX_ADAPTERS.map((adapter) => (
                    <SelectItem key={adapter} value={adapter}>
                      {t(`bots.runtime.adapters.${adapter}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </SettingItemActions>
          </SettingItem>

          {bot.sandbox.adapter === "apple-container" ? (
            <>
              <SettingSeparator />
              <SettingItem variant="muted">
                <SettingItemContent>
                  <SettingItemTitle>
                    {t("bots.runtime.containerImage")}
                  </SettingItemTitle>
                </SettingItemContent>
                <SettingItemActions>
                  <Input
                    value={image}
                    placeholder={t("bots.runtime.containerImagePlaceholder")}
                    className="w-56 shadow-xs"
                    onChange={(event) => {
                      setImage(event.target.value);
                    }}
                  />
                  {imageDirty ? (
                    <Button
                      size="sm"
                      disabled={isSaving}
                      onClick={() => {
                        void onUpdate({
                          sandbox: {
                            adapter: bot.sandbox.adapter,
                            isolateHome: bot.sandbox.isolateHome,
                            ...(trimmedImage ? { image: trimmedImage } : {}),
                          },
                        });
                      }}
                    >
                      {t("bots.actions.save")}
                    </Button>
                  ) : null}
                </SettingItemActions>
              </SettingItem>
            </>
          ) : null}

          <SettingSeparator />
          <SettingItem variant="muted">
            <SettingItemContent>
              <SettingItemTitle>
                {t("bots.runtime.isolateHome")}
              </SettingItemTitle>
            </SettingItemContent>
            <SettingItemActions>
              <Switch
                aria-label={t("bots.runtime.isolateHome")}
                checked={bot.sandbox.isolateHome}
                disabled={isSaving}
                onCheckedChange={(checked) => {
                  void onUpdate({
                    sandbox: { ...bot.sandbox, isolateHome: checked },
                  });
                }}
              />
            </SettingItemActions>
          </SettingItem>
        </SettingGroup>
      </div>

      <div>
        <SettingGroupHeader>
          <SettingGroupTitle className="text-base">
            {t("bots.runtime.envTitle")}
          </SettingGroupTitle>
        </SettingGroupHeader>

        <SettingGroup>
          {bot.envKeys.map((envKey) => (
            <Fragment key={envKey}>
              <SettingItem variant="muted">
                <SettingItemContent>
                  <SettingItemTitle>
                    <span className="font-mono text-xs">{envKey}</span>
                  </SettingItemTitle>
                </SettingItemContent>
                <SettingItemActions>
                  <span className="font-mono text-muted-foreground text-xs">
                    ••••••••
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    disabled={isSaving}
                    aria-label={`${t("bots.actions.delete")} ${envKey}`}
                    onClick={() => {
                      void onUpdate({ envPatch: { [envKey]: null } });
                    }}
                  >
                    <Trash2Icon />
                  </Button>
                </SettingItemActions>
              </SettingItem>
              <SettingSeparator />
            </Fragment>
          ))}

          <SettingItem variant="muted">
            <div className="flex w-full items-center gap-2">
              <Input
                value={newEnvKey}
                placeholder={t("bots.runtime.envKeyPlaceholder")}
                className="w-44 font-mono text-xs shadow-xs"
                autoComplete="off"
                onChange={(event) => {
                  setNewEnvKey(event.target.value);
                }}
              />
              <Input
                type="password"
                value={newEnvValue}
                placeholder={t("bots.runtime.envValuePlaceholder")}
                className="flex-1 font-mono text-xs shadow-xs"
                autoComplete="off"
                onChange={(event) => {
                  setNewEnvValue(event.target.value);
                }}
              />
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={isSaving || newEnvKey.trim().length === 0}
                onClick={() => {
                  void handleAddEnv();
                }}
              >
                <PlusIcon />
                {t("bots.actions.add")}
              </Button>
            </div>
          </SettingItem>
        </SettingGroup>
      </div>
    </div>
  );
}
