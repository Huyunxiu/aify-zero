import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@workspace/ui/components/item";
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

import { SettingFrame } from "./setting-frame";

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
              </ItemDescription>
            </ItemContent>
          </Item>
        </ItemGroup>
      </SettingFrame>
    </div>
  );
}
