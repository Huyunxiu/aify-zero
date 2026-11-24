import { useTheme } from "@workspace/ui/blocks/theme-provider";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select";
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
} from "./setting-frame";

export function AppearanceSettings() {
  const { t } = useTranslation();

  const themeContext = useTheme();

  const items = themeContext.themes.map((theme) => ({
    label: t(`settings.appearance.theme.${theme}`),
    value: theme,
  }));

  return (
    <div className="mx-auto flex w-2xl flex-col">
      <SettingGroupHeader>
        <SettingGroupTitle>{t("settings.appearance.title")}</SettingGroupTitle>
      </SettingGroupHeader>
      <SettingGroup>
        <SettingItem variant="muted">
          <SettingItemContent>
            <SettingItemTitle className="line-clamp-1">
              {t("settings.appearance.theme.title")}
            </SettingItemTitle>
            <SettingItemDescription>
              {t("settings.appearance.theme.description")}
            </SettingItemDescription>
          </SettingItemContent>
          {/* 控件放在 actions 里：描述的 line-clamp 带 overflow: hidden，会裁掉外阴影 */}
          <SettingItemActions>
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
              <SelectTrigger className="w-36 border-none shadow-xs">
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
          </SettingItemActions>
        </SettingItem>
      </SettingGroup>
    </div>
  );
}
