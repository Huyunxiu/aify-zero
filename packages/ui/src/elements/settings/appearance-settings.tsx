import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select";
import { useTheme } from "@workspace/ui/components/theme-provider";
import { useTranslation } from "react-i18next";

export function AppearanceSettings() {
  const { t } = useTranslation();

  const themeContext = useTheme();

  const items = themeContext.themes.map((theme) => ({
    label: t(`settings.appearance.theme.${theme}`),
    value: theme,
  }));

  return (
    <div className="mx-auto flex w-2xl flex-col">
      <div className="mb-6 flex">
        <h1 className="font-bold text-xl">{t("settings.appearance.title")}</h1>
      </div>
      <div className="flex w-full rounded-lg border bg-foreground-4">
        <div className="settings-item flex w-full items-center justify-between p-4">
          <div className="item-left grid gap-1">
            <div className="item-title text-xs">
              {t("settings.appearance.theme.title")}
            </div>
            <div className="item-desc text-muted-foreground text-xs">
              {t("settings.appearance.theme.description")}
            </div>
          </div>
          <div className="item-right">
            <Select
              items={items}
              onValueChange={(value) => {
                if (!value) {
                  return;
                }

                themeContext.setTheme(value);
              }}
              value={themeContext.theme}
            >
              <SelectTrigger className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent alignItemWithTrigger>
                <SelectGroup>
                  {themeContext.themes.map((theme) => (
                    <SelectItem key={theme} value={theme}>
                      {t(`settings.appearance.theme.${theme}`)}
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
