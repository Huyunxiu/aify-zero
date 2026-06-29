import { useLang } from "@workspace/ui/components/lang-provider";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select";
import { useTranslation } from "react-i18next";

export function GeneralSettings() {
  const { t } = useTranslation();
  const langContext = useLang();

  const items = langContext.langOptions.map((theme) => ({
    label: theme.nativeName,
    value: theme.key,
  }));

  return (
    <div className="mx-auto flex w-2xl flex-col">
      <div className="mb-6 flex">
        <h1 className="font-bold text-xl">{t("settings.general.title")}</h1>
      </div>
      <div className="flex w-full rounded border bg-white">
        <div className="settings-item flex w-full items-center justify-between p-4">
          <div className="item-left grid gap-1">
            <div className="item-title text-xs">
              {t("settings.general.language.title")}
            </div>
            <div className="item-desc text-muted-foreground text-xs">
              {t("settings.general.language.description")}
            </div>
          </div>
          <div className="item-right">
            <Select
              items={items}
              value={langContext.lang}
              onValueChange={(e) => {
                if (!e) {
                  return;
                }

                langContext.setLang(e);
              }}
            >
              <SelectTrigger className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent alignItemWithTrigger>
                <SelectGroup>
                  {langContext.langOptions.map((lang) => (
                    <SelectItem key={lang.key} value={lang.key}>
                      {lang.nativeName}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>
    </div>
  );
}
