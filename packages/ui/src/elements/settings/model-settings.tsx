import { useTranslation } from "react-i18next";

import { SettingFrame } from "./setting-frame";

export function ModelSettings() {
  const { t } = useTranslation();

  return (
    <div className="mx-auto flex w-2xl flex-col">
      <div className="mb-6 flex">
        <h1 className="font-bold text-xl">{t("settings.model.title")}</h1>
      </div>
      <SettingFrame></SettingFrame>
    </div>
  );
}
