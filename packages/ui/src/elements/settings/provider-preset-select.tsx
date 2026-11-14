import { PROVIDER_PRESETS } from "@workspace/shared/model";
import type { ProviderPreset } from "@workspace/shared/model";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxTrigger,
} from "@workspace/ui/components/combobox";
import { ProviderLogo } from "@workspace/ui/elements/provider-logo";
import { cn } from "@workspace/ui/lib/utils";
import { Pencil } from "lucide-react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

/** 下拉里的一行：一个预设，或者「自定义」。 */
interface PresetOption {
  id: string;
  name: string;
  icon?: string;
  preset?: ProviderPreset;
}

/** 自定义行的 id。预设 id 不会是空串。 */
const CUSTOM_ID = "";

/** 预设的图标；自定义行没有品牌图，用铅笔表示自己填。 */
function PresetMark(props: { icon?: string; name: string }) {
  if (!props.icon) {
    return <Pencil className="size-4 shrink-0 text-muted-foreground" />;
  }
  return <ProviderLogo icon={props.icon} name={props.name} />;
}

/**
 * 供应商预设选择器。
 *
 * 输入框兼作搜索：名字、id 和 API 地址都能匹配。选「自定义」只清掉预设身份，
 * 已经填进表单的内容留着，方便在预设基础上改。
 */
export function ProviderPresetSelect(props: {
  presetId: string | undefined;
  onSelect: (presetId: string | undefined) => void;
}) {
  const { t } = useTranslation();

  const custom = useMemo<PresetOption>(
    () => ({ id: CUSTOM_ID, name: t("settings.provider.custom") }),
    [t]
  );
  const items = useMemo<PresetOption[]>(
    () => [
      ...PROVIDER_PRESETS.map((preset) => ({
        id: preset.id,
        name: preset.name,
        icon: preset.icon,
        preset,
      })),
      custom,
    ],
    [custom]
  );

  // Base UI 按引用比较选中值，所以值必须取自 items 本身。
  const value =
    items.find((item) => item.id === (props.presetId ?? CUSTOM_ID)) ?? custom;
  const isCustom = value.id === CUSTOM_ID;

  return (
    <Combobox
      filter={(item: PresetOption, query: string) => {
        const needle = query.trim().toLowerCase();
        return (
          item.name.toLowerCase().includes(needle) ||
          item.id.includes(needle) ||
          (item.preset?.baseURL.toLowerCase().includes(needle) ?? false)
        );
      }}
      itemToStringLabel={(item) => item.name}
      items={items}
      onValueChange={(item) => props.onSelect(item?.preset?.id)}
      value={value}
    >
      <ComboboxTrigger
        aria-label={`${t("settings.provider.preset")}: ${value.name}`}
        className="flex h-8 w-full items-center gap-2 rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none transition-colors hover:bg-muted/40 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 data-popup-open:border-ring data-popup-open:ring-3 data-popup-open:ring-ring/50 dark:bg-input/30"
      >
        <PresetMark icon={value.icon} name={value.name} />
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-left",
            isCustom && "text-muted-foreground"
          )}
        >
          {value.name}
        </span>
      </ComboboxTrigger>
      <ComboboxContent className="w-(--anchor-width)">
        <ComboboxInput
          placeholder={t("settings.provider.presetPlaceholder")}
          showTrigger={false}
        />
        <ComboboxEmpty>{t("settings.provider.noPresetMatches")}</ComboboxEmpty>
        <ComboboxList>
          {(item: PresetOption) => (
            <ComboboxItem key={item.id || "custom"} value={item}>
              <PresetMark icon={item.icon} name={item.name} />
              <span
                className={cn(
                  "truncate",
                  item.id === CUSTOM_ID && "text-muted-foreground"
                )}
              >
                {item.name}
              </span>
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}
