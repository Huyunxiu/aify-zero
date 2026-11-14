import { Button } from "@workspace/ui/components/button";
import { Input } from "@workspace/ui/components/input";
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
import { toastManager } from "@workspace/ui/components/toast";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { SettingFrame } from "./setting-frame";

/**
 * 给另一台设备签发登录链接。
 *
 * 链接里的票据绑定在本次进程运行上，重启后失效；页面上只显示最近拿到的
 * 一条，不做持久化。
 *
 * @returns 设置页里的一行，以及生成后的链接。
 */
export function GeneralSettings() {
  const { t } = useTranslation();
  const langContext = useLang();
  const [link, setLink] = useState<string>();
  const [creating, setCreating] = useState(false);

  const items = langContext.langOptions.map((theme) => ({
    label: theme.nativeName,
    value: theme.key,
  }));

  const createLoginLink = async (): Promise<void> => {
    setCreating(true);

    try {
      const response = await fetch(
        new URL("api/auth/login-link", document.baseURI),
        { credentials: "same-origin", method: "POST" }
      );

      if (!response.ok) {
        throw new Error(`login link failed: ${String(response.status)}`);
      }

      const body: unknown = await response.json();

      if (
        typeof body !== "object" ||
        body === null ||
        !("url" in body) ||
        typeof body.url !== "string"
      ) {
        throw new Error("login link response has no url");
      }

      setLink(body.url);
    } catch {
      toastManager.add({ title: t("requestFailed"), type: "error" });
    } finally {
      setCreating(false);
    }
  };

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
          <Item variant="muted">
            <ItemContent>
              <ItemTitle className="line-clamp-1">
                {t("settings.general.signIn.title")}
              </ItemTitle>
              <ItemDescription>
                {t("settings.general.signIn.description")}
              </ItemDescription>
            </ItemContent>
            <ItemContent className="flex-none text-center">
              <Button
                disabled={creating}
                onClick={() => {
                  void createLoginLink();
                }}
                size="sm"
                variant="outline"
              >
                {creating
                  ? t("settings.general.signIn.creating")
                  : t("settings.general.signIn.create")}
              </Button>
            </ItemContent>
          </Item>
          {link === undefined ? null : (
            <Item variant="muted">
              <ItemContent>
                <Input readOnly value={link} />
              </ItemContent>
            </Item>
          )}
        </ItemGroup>
      </SettingFrame>
    </div>
  );
}
