import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@workspace/ui/components/item";
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

import { SettingFrame } from "./setting-frame";

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
      <SettingFrame>
        <ItemGroup>
          <Item variant="muted">
            <ItemContent>
              <ItemTitle className="line-clamp-1">
                {t("settings.general.language.title")}
              </ItemTitle>
              <ItemDescription>
                {t("settings.general.language.description")}
              </ItemDescription>
            </ItemContent>
            <ItemContent className="flex-none text-center">
              <ItemDescription>
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
              </ItemDescription>
            </ItemContent>
          </Item>
        </ItemGroup>
      </SettingFrame>
    </div>
  );
}
