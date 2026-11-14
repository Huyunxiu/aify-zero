import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PROVIDER_PRESETS, slugifyProviderId } from "@workspace/shared/model";
import type { ModelProtocol, ModelRef } from "@workspace/shared/model";
import { Badge } from "@workspace/ui/components/badge";
import { Button } from "@workspace/ui/components/button";
import { Checkbox } from "@workspace/ui/components/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@workspace/ui/components/dialog";
import { Input } from "@workspace/ui/components/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
  InputGroupText,
} from "@workspace/ui/components/input-group";
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@workspace/ui/components/segmented-control";
import { Spinner } from "@workspace/ui/components/spinner";
import { Switch } from "@workspace/ui/components/switch";
import { Textarea } from "@workspace/ui/components/textarea";
import { ModelLogo } from "@workspace/ui/elements/model-logo";
import { ProviderLogo } from "@workspace/ui/elements/provider-logo";
import { client } from "@workspace/ui/lib/orpc";
import { cn } from "@workspace/ui/lib/utils";
import {
  ChevronRight,
  Eye,
  EyeOff,
  Pencil,
  PlusIcon,
  RefreshCw,
  Trash,
  X,
} from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { ProviderPresetSelect } from "./provider-preset-select";
import { SettingFrame } from "./setting-frame";

type SettingsData = Awaited<ReturnType<typeof client.setting.get>>;
type ProviderRow = SettingsData["providers"][number];
type ModelRow = ProviderRow["models"][number];
type ListedModel = Awaited<
  ReturnType<typeof client.setting.listModels>
>["models"][number];

const MODALITIES = ["text", "audio", "image", "video", "pdf"] as const;
type Modality = (typeof MODALITIES)[number];

const MODALITY_KEYS = {
  text: "modelCapability.modalities.text",
  audio: "modelCapability.modalities.audio",
  image: "modelCapability.modalities.image",
  video: "modelCapability.modalities.video",
  pdf: "modelCapability.modalities.pdf",
} as const;

/** 保存后只剩地址和名字：地址对得上预设就用预设的图标。 */
function presetIconFor(baseURL: string): string | undefined {
  return PROVIDER_PRESETS.find((entry) => entry.baseURL === baseURL)?.icon;
}

const DEFAULT_CONTEXT = 131_072;
const CONTEXT_UNIT = 1024;
const DEFAULT_INPUT: Modality[] = ["text", "image"];
const DEFAULT_OUTPUT: Modality[] = ["text"];
const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

/** SDK 追加在 API 地址后的路径：换协议时地址不变，只换这一截。 */
const PROTOCOL_PATHS = {
  "openai-chat": "/chat/completions",
  "openai-responses": "/responses",
} as const satisfies Record<ModelProtocol, string>;

const PROTOCOLS = [
  { value: "openai-chat", label: "settings.provider.protocols.openai-chat" },
  {
    value: "openai-responses",
    label: "settings.provider.protocols.openai-responses",
  },
] as const satisfies readonly { value: ModelProtocol; label: string }[];

type Editor = { mode: "create" } | { mode: "edit"; providerId: string };

interface Draft {
  name: string;
  protocol: ModelProtocol;
  baseURL: string;
  apiKey: string;
  headersText: string;
  active: boolean;
  models: ModelRow[];
}

/** Tokens 到界面上的 k；去掉浮点噪声。 */
function toKilotokens(tokens: number) {
  return Number((tokens / CONTEXT_UNIT).toFixed(2));
}

/** 128k / 1M 这种写法比裸数字好读。 */
function formatContext(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${Number((tokens / 1_000_000).toFixed(1))}M`;
  }
  return `${Math.round(tokens / CONTEXT_UNIT)}k`;
}

/** 隐藏密钥时留在两头的字符数。 */
const KEY_EDGE = 4;

/** 藏起中段，只露首尾四位；短过两头的密钥整串遮住，不然等于没遮。 */
function maskSecret(value: string): string {
  if (value.length <= KEY_EDGE * 2) {
    return "•".repeat(value.length);
  }
  return `${value.slice(0, KEY_EDGE)}...${value.slice(-KEY_EDGE)}`;
}

/** "Key: value" 逐行 → 请求头。空行忽略。 */
function parseHeaders(text: string): Record<string, string> | undefined {
  const entries = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const cut = line.indexOf(":");
      return cut > 0
        ? ([line.slice(0, cut).trim(), line.slice(cut + 1).trim()] as const)
        : undefined;
    })
    .filter((entry): entry is readonly [string, string] => entry !== undefined);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function stringifyHeaders(headers: Record<string, string> | undefined): string {
  return Object.entries(headers ?? {})
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");
}

/** slug 撞了就加序号，和保存时服务端的收敛规则一致。 */
function uniqueProviderId(name: string, taken: readonly string[]): string {
  const base = slugifyProviderId(name);
  if (!taken.includes(base)) {
    return base;
  }
  let index = 2;
  while (taken.includes(`${base}-${index}`)) {
    index += 1;
  }
  return `${base}-${index}`;
}

function listedModelToRow(model: ListedModel): ModelRow {
  return {
    id: model.id,
    name: model.name,
    active: true,
    reasoning: true,
    modalities: {
      input: model.input ?? [...DEFAULT_INPUT],
      output: model.output ?? [...DEFAULT_OUTPUT],
    },
    limit: { context: model.context ?? DEFAULT_CONTEXT },
  };
}

function manualModel(id: string): ModelRow {
  return {
    id,
    name: id,
    active: true,
    reasoning: true,
    modalities: { input: [...DEFAULT_INPUT], output: [...DEFAULT_OUTPUT] },
    limit: { context: DEFAULT_CONTEXT },
  };
}

/** 新内容出现后把它带进视野，用最短距离。 */
function revealNode(node: HTMLElement | null) {
  node?.scrollIntoView({
    behavior: window.matchMedia(REDUCED_MOTION).matches ? "auto" : "smooth",
    block: "nearest",
  });
}

function ProtocolPicker(props: {
  value: ModelProtocol;
  onChange: (value: ModelProtocol) => void;
}) {
  const { t } = useTranslation();
  return (
    <SegmentedControl className="w-full" size="sm">
      {PROTOCOLS.map((option) => (
        <SegmentedControlItem
          aria-pressed={props.value === option.value}
          className="flex-1"
          data-checked={props.value === option.value ? "" : undefined}
          key={option.value}
          onClick={() => props.onChange(option.value)}
        >
          {t(option.label)}
        </SegmentedControlItem>
      ))}
    </SegmentedControl>
  );
}

export function ProviderSettings() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [editor, setEditor] = useState<Editor | null>(null);
  const [listError, setListError] = useState<string | undefined>();
  // 列表开关的序号：只认最后一次切换的回包。
  const toggleSeq = useRef(0);

  const settingsQuery = useQuery({
    queryKey: ["settings"],
    queryFn: async () => await client.setting.get(),
  });

  const providers = settingsQuery.data?.providers ?? [];

  const saveMutation = useMutation({
    // 每次保存都提交整份 providers。同作用域的保存排队执行，否则乱序落地时
    // 旧快照会把新改动盖回去。
    scope: { id: "settings-save" },
    mutationFn: async (input: {
      providers: ProviderRow[];
      defaultModel?: ModelRef | null;
    }) => await client.setting.update(input),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["settings"] });
    },
  });

  /** 列表开关的保存：乐观改动已经在缓存里，成功就不再拉一次，免得闪回。 */
  const toggleMutation = useMutation({
    scope: { id: "settings-save" },
    mutationFn: async (input: { providers: ProviderRow[] }) =>
      await client.setting.update(input),
    onError: () => {
      // 失败后回到服务端的值：缓存里的乐观改动不成立。
      void queryClient.invalidateQueries({ queryKey: ["settings"] });
    },
  });

  const save = async (next: ProviderRow[], defaultModel?: ModelRef | null) => {
    await saveMutation.mutateAsync({
      providers: next,
      ...(defaultModel === undefined ? {} : { defaultModel }),
    });
  };

  /** 列表上的开关：先改缓存，再排队存。连续切换读的是最新缓存，不会互相覆盖。 */
  const toggleProvider = (id: string, active: boolean) => {
    const data = queryClient.getQueryData<SettingsData>(["settings"]);
    if (!data) {
      return;
    }
    const next = data.providers.map((provider) =>
      provider.id === id ? { ...provider, active } : provider
    );
    queryClient.setQueryData<SettingsData>(["settings"], {
      ...data,
      providers: next,
    });
    setListError(undefined);
    const seq = ++toggleSeq.current;
    toggleMutation.mutate(
      { providers: next },
      {
        onSuccess: (saved) => {
          // 只认最后一次切换的回包：更早的回包已经不含后来的改动。
          if (seq === toggleSeq.current) {
            queryClient.setQueryData<SettingsData>(["settings"], saved);
          }
        },
        onError: (error) => {
          setListError(error instanceof Error ? error.message : String(error));
        },
      }
    );
  };

  const editing =
    editor?.mode === "edit"
      ? providers.find((provider) => provider.id === editor.providerId)
      : undefined;

  return (
    <div className="mx-auto flex w-2xl flex-col">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="font-bold text-xl">{t("settings.provider.title")}</h1>
        <Button size="sm" onClick={() => setEditor({ mode: "create" })}>
          <PlusIcon />
          {t("settings.provider.addProvider")}
        </Button>
      </div>

      <SettingFrame className="overflow-hidden">
        {providers.length === 0 ? (
          <div className="flex h-24 items-center justify-center text-muted-foreground text-sm">
            {t("settings.provider.empty")}
          </div>
        ) : (
          providers.map((provider, index) => (
            <div
              className={cn(
                "flex items-center gap-1 pr-2 pl-1",
                index > 0 && "border-t"
              )}
              key={provider.id}
            >
              <button
                className="group flex min-w-0 flex-1 items-center gap-3 rounded-md px-2 py-2.5 text-left outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50"
                onClick={() =>
                  setEditor({ mode: "edit", providerId: provider.id })
                }
                type="button"
              >
                <ProviderLogo
                  className="size-5"
                  icon={presetIconFor(provider.baseURL)}
                  name={provider.name}
                />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="truncate font-medium">
                      {provider.name}
                    </span>
                    {provider.active ? null : (
                      <span className="text-muted-foreground text-xs">
                        {t("settings.provider.inactive")}
                      </span>
                    )}
                  </span>
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-muted-foreground text-xs">
                      {provider.baseURL}
                    </span>
                    <span className="shrink-0 text-muted-foreground text-xs tabular-nums">
                      {t("settings.provider.modelCount", {
                        count: provider.models.length,
                      })}
                    </span>
                  </span>
                </span>
              </button>
              <Switch
                aria-label={`${t("settings.provider.active")} ${provider.name}`}
                checked={provider.active}
                onCheckedChange={(active) =>
                  toggleProvider(provider.id, active)
                }
              />
              <ChevronRight
                aria-hidden="true"
                className="size-4 shrink-0 text-muted-foreground/60"
              />
            </div>
          ))
        )}
      </SettingFrame>

      {listError ? (
        <p className="mt-2 text-destructive text-xs" role="alert">
          {listError}
        </p>
      ) : null}

      {editor ? (
        <ProviderWorkbench
          key={editing?.id ?? "new"}
          onClose={() => setEditor(null)}
          onDelete={
            editing
              ? async () => {
                  await save(
                    providers.filter((provider) => provider.id !== editing.id)
                  );
                  setEditor(null);
                }
              : undefined
          }
          onSave={async (values) => {
            const id =
              editing?.id ??
              uniqueProviderId(
                values.name,
                providers.map((provider) => provider.id)
              );
            const saved: ProviderRow = { ...values, id };
            const next = editing
              ? providers.map((provider) =>
                  provider.id === editing.id ? saved : provider
                )
              : [...providers, saved];
            const [first] = saved.models;
            // 没有默认模型时，新加的第一个模型顺带成为默认：
            // 新会话才有东西可选。
            const needsDefault =
              (settingsQuery.data?.defaultModel ?? null) === null &&
              first !== undefined;
            await save(
              next,
              needsDefault ? { providerId: id, modelId: first.id } : undefined
            );
            setEditor(null);
          }}
          provider={editing}
        />
      ) : null}
    </div>
  );
}

function ProviderWorkbench(props: {
  provider: ProviderRow | undefined;
  onClose: () => void;
  onSave: (values: Omit<ProviderRow, "id">) => Promise<void>;
  onDelete?: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const { provider } = props;
  const [draft, setDraft] = useState<Draft>(() =>
    provider
      ? {
          name: provider.name,
          protocol: provider.protocol,
          baseURL: provider.baseURL,
          // 密钥跟着草稿走：界面上看到的就是会存下去的那一把。
          apiKey: provider.apiKey,
          headersText: stringifyHeaders(provider.headers),
          active: provider.active,
          models: provider.models.map((model) => ({ ...model })),
        }
      : {
          name: "",
          protocol: "openai-chat",
          baseURL: "",
          apiKey: "",
          headersText: "",
          active: true,
          models: [],
        }
  );
  const [presetId, setPresetId] = useState<string | undefined>(
    () =>
      PROVIDER_PRESETS.find((entry) => entry.baseURL === provider?.baseURL)?.id
  );
  const [editingModelId, setEditingModelId] = useState<string | null>(null);
  // 新建时不自动展开添加区：先看模型清单，要加再点按钮。编辑时没有模型的
  // 供应商仍然直接给添加区，省一次点击。
  const [showAdd, setShowAdd] = useState(provider?.models.length === 0);
  const [showHeaders, setShowHeaders] = useState(
    Object.keys(provider?.headers ?? {}).length > 0
  );
  const [saving, setSaving] = useState(false);
  const [keyRevealed, setKeyRevealed] = useState(false);
  const [keyFocused, setKeyFocused] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const nameRef = useRef<HTMLInputElement | null>(null);
  const keyRef = useRef<HTMLInputElement | null>(null);
  const keyInputId = useId();
  const editorRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const addPanelRef = useRef<HTMLDivElement | null>(null);
  const lastCount = useRef(draft.models.length);

  const preset = PROVIDER_PRESETS.find((entry) => entry.id === presetId);
  // 选了预设之后，新建弹窗的头部就和编辑弹窗一样：图标、名字、模型数、控制台。
  const hasIdentity = provider !== undefined || preset !== undefined;
  const headerName = draft.name || provider?.name || preset?.name || "";
  // 密钥的三种状态：失焦是遮罩预览，聚焦后的隐藏态是密码模式，点眼睛才是明文。
  const keyPreviewed = !(keyRevealed || keyFocused);
  const canSubmit =
    draft.name.trim().length > 0 && draft.baseURL.trim().length > 0;

  useEffect(() => {
    if (editingModelId) {
      revealNode(editorRef.current);
    }
  }, [editingModelId]);

  // 新加的模型在上方，回到列表，不让它被下方的添加区挡住。
  useEffect(() => {
    if (draft.models.length > lastCount.current) {
      revealNode(listRef.current);
    }
    lastCount.current = draft.models.length;
  }, [draft.models.length]);

  useEffect(() => {
    if (showAdd) {
      revealNode(addPanelRef.current);
    }
  }, [showAdd]);

  const patch = (values: Partial<Draft>) =>
    setDraft((current) => ({ ...current, ...values }));

  /**
   * 从遮罩预览进到编辑：整把密钥先选中，接着打字或粘贴就是换一把，不会接在旧
   * 密钥后面变成一把无效的密钥。
   */
  const handleKeyFocus = () => {
    const fromPreview = keyPreviewed;
    setKeyFocused(true);
    if (!fromPreview || draft.apiKey.length === 0) {
      return;
    }
    requestAnimationFrame(() => keyRef.current?.select());
  };

  const applyPreset = (id: string | undefined) => {
    setPresetId(id);
    const next = PROVIDER_PRESETS.find((entry) => entry.id === id);
    if (!next) {
      return;
    }
    patch({
      name: next.name,
      protocol: next.protocol,
      baseURL: next.baseURL,
      headersText: stringifyHeaders(next.headers),
    });
  };

  const patchModel = (id: string, values: Partial<ModelRow>) => {
    setDraft((current) => ({
      ...current,
      models: current.models.map((model) =>
        model.id === id ? { ...model, ...values } : model
      ),
    }));
  };

  const addModels = (models: ModelRow[]) => {
    setDraft((current) => ({
      ...current,
      models: [
        ...current.models,
        ...models.filter(
          (model) =>
            !current.models.some((existing) => existing.id === model.id)
        ),
      ],
    }));
  };

  const submit = async () => {
    setSaving(true);
    setError(undefined);
    try {
      await props.onSave({
        name: draft.name.trim(),
        protocol: draft.protocol,
        baseURL: draft.baseURL.trim(),
        apiKey: draft.apiKey,
        headers: parseHeaders(draft.headersText),
        active: draft.active,
        models: draft.models,
      });
    } catch (saveError) {
      // 保存失败时保留弹窗，让用户改完再存。
      setError(
        saveError instanceof Error ? saveError.message : String(saveError)
      );
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!props.onDelete) {
      return;
    }
    setSaving(true);
    setError(undefined);
    try {
      await props.onDelete();
    } catch (deleteError) {
      setError(
        deleteError instanceof Error ? deleteError.message : String(deleteError)
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) {
          props.onClose();
        }
      }}
    >
      <DialogContent
        className="flex h-[min(50rem,calc(100vh-9rem))] flex-col gap-0 overflow-hidden p-0"
        initialFocus={nameRef}
        showCloseButton
        size="large"
      >
        <DialogHeader className="flex shrink-0 flex-row items-center gap-3 border-b px-5 py-3.5 pr-12">
          <div className="min-w-0 flex-1">
            <DialogTitle className="flex min-w-0 items-center gap-2">
              {hasIdentity ? (
                <ProviderLogo
                  className="size-5"
                  icon={preset?.icon}
                  name={headerName}
                />
              ) : null}
              <span className="truncate">
                {hasIdentity ? headerName : t("settings.provider.createTitle")}
              </span>
              {hasIdentity ? (
                <span className="shrink-0 font-normal text-muted-foreground text-xs tabular-nums">
                  {t("settings.provider.modelCount", {
                    count: draft.models.length,
                  })}
                </span>
              ) : null}
            </DialogTitle>
            {hasIdentity ? null : (
              <DialogDescription className="mt-0.5 truncate text-xs">
                {t("settings.provider.createDescription")}
              </DialogDescription>
            )}
          </div>

          {preset ? (
            <a
              className="shrink-0 text-muted-foreground text-xs underline underline-offset-2 transition-colors hover:text-foreground"
              href={preset.website}
              rel="noreferrer"
              target="_blank"
              title={preset.website}
            >
              {t("settings.provider.console")}
            </a>
          ) : null}

          {provider ? (
            <Switch
              aria-label={`${t("settings.provider.active")} ${provider.name}`}
              checked={draft.active}
              onCheckedChange={(active) => patch({ active })}
            />
          ) : null}
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {provider ? null : (
            <section className="px-5 py-4">
              <span className="mb-1 block text-muted-foreground text-xs">
                {t("settings.provider.preset")}
              </span>
              <ProviderPresetSelect
                onSelect={applyPreset}
                presetId={presetId}
              />
            </section>
          )}

          <section
            className={cn("px-5 py-4", provider ? undefined : "border-t")}
          >
            <div className="flex flex-col gap-4">
              <label className="block">
                <span className="mb-1 block text-muted-foreground text-xs">
                  {t("settings.provider.name")}
                </span>
                <Input
                  onChange={(event) => patch({ name: event.target.value })}
                  placeholder={t("settings.provider.namePlaceholder")}
                  ref={nameRef}
                  value={draft.name}
                />
              </label>

              <label className="block">
                <span className="mb-1 block text-muted-foreground text-xs">
                  {t("settings.provider.baseURL")}
                </span>
                <InputGroup>
                  <InputGroupInput
                    onChange={(event) => patch({ baseURL: event.target.value })}
                    placeholder="https://api.example.com/v1"
                    value={draft.baseURL}
                  />
                  <InputGroupAddon align="inline-end">
                    <InputGroupText className="font-mono text-xs">
                      {PROTOCOL_PATHS[draft.protocol]}
                    </InputGroupText>
                  </InputGroupAddon>
                </InputGroup>
              </label>

              <div>
                <span className="mb-1 block text-muted-foreground text-xs">
                  {t("settings.provider.protocol")}
                </span>
                <ProtocolPicker
                  onChange={(protocol) => patch({ protocol })}
                  value={draft.protocol}
                />
              </div>

              <div>
                <label
                  className="mb-1 block text-muted-foreground text-xs"
                  htmlFor={keyInputId}
                >
                  {t("settings.provider.apiKey")}
                </label>
                {/* 失焦时是遮罩预览，聚焦后切到密码模式：能输入，但不显示明文。
                    明文只有右边的按钮能切出来。 */}
                <InputGroup>
                  <InputGroupInput
                    autoComplete="off"
                    className={cn(
                      "font-mono",
                      keyPreviewed ? "cursor-default select-none" : undefined
                    )}
                    id={keyInputId}
                    onBlur={() => setKeyFocused(false)}
                    onChange={(event) => patch({ apiKey: event.target.value })}
                    onFocus={handleKeyFocus}
                    placeholder={t("settings.provider.apiKeyPlaceholder")}
                    readOnly={keyPreviewed}
                    ref={keyRef}
                    spellCheck={false}
                    type={keyRevealed || keyPreviewed ? "text" : "password"}
                    value={
                      keyPreviewed ? maskSecret(draft.apiKey) : draft.apiKey
                    }
                  />
                  <InputGroupAddon align="inline-end">
                    <InputGroupButton
                      aria-label={
                        keyRevealed
                          ? t("settings.provider.hideApiKey")
                          : t("settings.provider.showApiKey")
                      }
                      onClick={() => setKeyRevealed((current) => !current)}
                      size="icon-xs"
                    >
                      {keyRevealed ? <EyeOff /> : <Eye />}
                    </InputGroupButton>
                  </InputGroupAddon>
                </InputGroup>
                {preset ? (
                  <div className="mt-1.5 flex gap-3 text-xs">
                    <a
                      className="underline underline-offset-2"
                      href={preset.keysURL}
                      rel="noreferrer"
                      target="_blank"
                    >
                      {t("settings.provider.getKey")}
                    </a>
                    <a
                      className="underline underline-offset-2"
                      href={preset.website}
                      rel="noreferrer"
                      target="_blank"
                    >
                      {t("settings.provider.console")}
                    </a>
                  </div>
                ) : null}
              </div>

              <div>
                <button
                  className="flex items-center gap-1 text-muted-foreground text-xs transition-colors hover:text-foreground"
                  onClick={() => setShowHeaders((open) => !open)}
                  type="button"
                >
                  <ChevronRight
                    className={cn(
                      "size-3 transition-transform duration-150",
                      showHeaders && "rotate-90"
                    )}
                  />
                  {t("settings.provider.headers")}
                </button>
                {showHeaders ? (
                  <Textarea
                    aria-label={t("settings.provider.headers")}
                    className="mt-2 min-h-16 font-mono text-xs"
                    onChange={(event) =>
                      patch({ headersText: event.target.value })
                    }
                    placeholder={t("settings.provider.headersPlaceholder")}
                    value={draft.headersText}
                  />
                ) : null}
              </div>
            </div>
          </section>

          <section className="border-t px-5 py-4">
            <div className="mb-2 flex items-center gap-2">
              <h3 className="text-muted-foreground text-xs">
                {t("settings.provider.models")}
              </h3>
              <span className="text-muted-foreground text-xs tabular-nums">
                {draft.models.length}
              </span>
              <Button
                className="ml-auto"
                onClick={() => setShowAdd((open) => !open)}
                size="xs"
                variant="ghost"
              >
                {showAdd ? <X /> : <PlusIcon />}
                {showAdd
                  ? t("settings.provider.collapse")
                  : t("settings.provider.addModels")}
              </Button>
            </div>

            {draft.models.length === 0 ? (
              <p className="py-2 text-muted-foreground text-xs">
                {t("settings.provider.noModels")}
              </p>
            ) : (
              <div className="flex flex-col" ref={listRef}>
                {draft.models.map((model) => (
                  <div key={model.id}>
                    <div className="flex items-center gap-2 rounded-md px-1.5 py-2 hover:bg-muted/40">
                      <ModelLogo
                        className="size-4"
                        model={model.name}
                        providerIcon={preset?.icon}
                      />
                      <button
                        className="min-w-0 flex-1 text-left outline-none focus-visible:underline"
                        onClick={() =>
                          setEditingModelId((current) =>
                            current === model.id ? null : model.id
                          )
                        }
                        type="button"
                      >
                        <span className="flex min-w-0 items-center gap-1.5">
                          <span className="truncate text-sm">{model.name}</span>
                          {(model.reasoning ?? true) ? (
                            <Badge
                              className="h-4 shrink-0 px-1 text-[10px]"
                              variant="outline"
                            >
                              {t("modelCapability.reasoning")}
                            </Badge>
                          ) : null}
                        </span>
                        {model.name === model.id ? null : (
                          <span className="block truncate font-mono text-[11px] text-muted-foreground">
                            {model.id}
                          </span>
                        )}
                      </button>
                      {(model.limit?.context ?? 0) > 0 ? (
                        <span className="shrink-0 text-muted-foreground text-xs tabular-nums">
                          {formatContext(model.limit?.context ?? 0)}
                        </span>
                      ) : null}
                      <Switch
                        aria-label={`${t("settings.provider.active")} ${model.name}`}
                        checked={model.active}
                        onCheckedChange={(active) =>
                          patchModel(model.id, { active })
                        }
                        size="sm"
                      />
                      <Button
                        aria-label={t("settings.provider.editModelTitle")}
                        onClick={() =>
                          setEditingModelId((current) =>
                            current === model.id ? null : model.id
                          )
                        }
                        size="icon-sm"
                        variant="ghost"
                      >
                        <Pencil />
                      </Button>
                      <Button
                        aria-label={t("settings.provider.delete")}
                        onClick={() =>
                          setDraft((current) => ({
                            ...current,
                            models: current.models.filter(
                              (entry) => entry.id !== model.id
                            ),
                          }))
                        }
                        size="icon-sm"
                        variant="ghost"
                      >
                        <Trash />
                      </Button>
                    </div>
                    {editingModelId === model.id ? (
                      <div ref={editorRef}>
                        <ModelEditor
                          model={model}
                          onChange={(values) => patchModel(model.id, values)}
                          onDone={() => setEditingModelId(null)}
                        />
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            )}

            {showAdd ? (
              <div ref={addPanelRef}>
                <AddModelsPanel
                  apiKey={draft.apiKey}
                  baseURL={draft.baseURL}
                  className="mt-3"
                  existingIds={draft.models.map((model) => model.id)}
                  headers={parseHeaders(draft.headersText)}
                  onAdd={addModels}
                  onCollapse={() => setShowAdd(false)}
                />
              </div>
            ) : null}
          </section>
        </div>

        <footer className="flex shrink-0 items-center gap-2 border-t px-5 py-3">
          {props.onDelete ? (
            confirmingDelete ? (
              <div className="flex items-center gap-2 text-xs">
                <span className="text-muted-foreground">
                  {draft.models.length > 0
                    ? t("settings.provider.deleteWithModels", {
                        count: draft.models.length,
                      })
                    : t("settings.provider.deleteConfirm")}
                </span>
                <Button
                  onClick={() => setConfirmingDelete(false)}
                  size="xs"
                  variant="ghost"
                >
                  {t("settings.provider.cancel")}
                </Button>
                <Button
                  disabled={saving}
                  onClick={() => void remove()}
                  size="xs"
                  variant="destructive"
                >
                  {t("settings.provider.delete")}
                </Button>
              </div>
            ) : (
              <Button
                className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                onClick={() => setConfirmingDelete(true)}
                size="sm"
                variant="ghost"
              >
                {t("settings.provider.deleteProvider")}
              </Button>
            )
          ) : null}

          <div className="ml-auto flex items-center gap-2">
            {error ? (
              <span
                className="max-w-64 truncate text-destructive text-xs"
                role="alert"
                title={error}
              >
                {error}
              </span>
            ) : null}
            <Button disabled={saving} onClick={props.onClose} variant="outline">
              {t("settings.provider.cancel")}
            </Button>
            <Button
              disabled={!canSubmit || saving}
              loading={saving}
              onClick={() => void submit()}
            >
              {provider
                ? t("settings.provider.update")
                : t("settings.provider.create")}
            </Button>
          </div>
        </footer>
      </DialogContent>
    </Dialog>
  );
}

function ModalityPicker(props: {
  label: string;
  value: readonly Modality[];
  onChange: (next: Modality[]) => void;
}) {
  const { t } = useTranslation();
  return (
    <div>
      <span className="mb-1 block text-muted-foreground text-xs">
        {props.label}
      </span>
      <div className="flex flex-wrap gap-x-3 gap-y-1.5">
        {MODALITIES.map((modality) => (
          <label className="flex items-center gap-1.5 text-xs" key={modality}>
            <Checkbox
              checked={props.value.includes(modality)}
              className="size-3.5"
              onCheckedChange={(checked) =>
                props.onChange(
                  checked
                    ? [...props.value, modality]
                    : props.value.filter((entry) => entry !== modality)
                )
              }
            />
            {t(MODALITY_KEYS[modality])}
          </label>
        ))}
      </div>
    </div>
  );
}

/** 模型的就地编辑器：改动写回弹窗草稿。 */
function ModelEditor(props: {
  model: ModelRow;
  onChange: (patch: Partial<ModelRow>) => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const { model, onChange } = props;
  const [context, setContext] = useState(
    String(toKilotokens(model.limit?.context ?? DEFAULT_CONTEXT))
  );
  const input = model.modalities?.input ?? DEFAULT_INPUT;
  const output = model.modalities?.output ?? DEFAULT_OUTPUT;

  const commitContext = (value: string) => {
    const kilotokens = Number(value.trim());
    if (Number.isFinite(kilotokens) && kilotokens > 0) {
      onChange({ limit: { context: Math.round(kilotokens * CONTEXT_UNIT) } });
    }
  };

  return (
    <div className="mt-1 mb-2 rounded-lg border bg-muted/30 p-3">
      <div className="flex items-end gap-2">
        <label className="min-w-0 flex-1">
          <span className="mb-1 block text-muted-foreground text-xs">
            {t("settings.provider.name")}
          </span>
          <Input
            className="h-7"
            onChange={(event) => onChange({ name: event.target.value })}
            value={model.name}
          />
        </label>
        <label className="w-24">
          <span className="mb-1 block text-muted-foreground text-xs">
            {t("modelCapability.contextWindow")}
          </span>
          <InputGroup className="h-7">
            <InputGroupInput
              inputMode="decimal"
              onBlur={() =>
                setContext(
                  String(toKilotokens(model.limit?.context ?? DEFAULT_CONTEXT))
                )
              }
              onChange={(event) => {
                setContext(event.target.value);
                commitContext(event.target.value);
              }}
              value={context}
            />
            <InputGroupAddon align="inline-end">
              <InputGroupText>k</InputGroupText>
            </InputGroupAddon>
          </InputGroup>
        </label>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3">
        <ModalityPicker
          label={t("modelCapability.input")}
          onChange={(next) =>
            onChange({
              modalities: { input: next, output },
            })
          }
          value={input}
        />
        <ModalityPicker
          label={t("modelCapability.output")}
          onChange={(next) =>
            onChange({
              modalities: { input, output: next },
            })
          }
          value={output}
        />
      </div>

      <div className="mt-3 flex items-center justify-between">
        <label className="flex items-center gap-2 text-xs">
          <Checkbox
            checked={model.reasoning ?? true}
            className="size-3.5"
            onCheckedChange={(checked) => onChange({ reasoning: checked })}
          />
          {t("modelCapability.reasoning")}
        </label>
        <Button size="xs" variant="ghost" onClick={props.onDone}>
          {t("settings.provider.done")}
        </Button>
      </div>
    </div>
  );
}

/** 拉取供应商的模型列表并勾选；拉不到时退到手填。 */
function AddModelsPanel(props: {
  baseURL: string;
  apiKey: string;
  headers?: Record<string, string>;
  existingIds: readonly string[];
  onAdd: (models: ModelRow[]) => void;
  /** 全部加完后收起面板：这时已经没有可选项了。 */
  onCollapse?: () => void;
  className?: string;
}) {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<"idle" | "loading" | "ready" | "error">(
    "idle"
  );
  const [catalog, setCatalog] = useState<ListedModel[]>([]);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [manual, setManual] = useState("");
  const [error, setError] = useState("");
  const rootRef = useRef<HTMLDivElement | null>(null);

  // 结果回到列表后整块会变高，把它带回视野。
  useEffect(() => {
    if (phase === "ready") {
      revealNode(rootRef.current);
    }
  }, [phase]);

  const unfiltered = catalog.filter(
    (model) => !props.existingIds.includes(model.id)
  );
  const needle = filter.trim().toLowerCase();
  const available = unfiltered.filter(
    (model) =>
      needle.length === 0 ||
      model.id.toLowerCase().includes(needle) ||
      model.name.toLowerCase().includes(needle)
  );
  const chosen = unfiltered.filter((model) => selected.has(model.id));

  const load = async () => {
    setPhase("loading");
    setError("");
    try {
      const { models } = await client.setting.listModels({
        baseURL: props.baseURL,
        apiKey: props.apiKey,
        ...(props.headers ? { headers: props.headers } : {}),
      });
      setCatalog(models);
      setSelected(new Set());
      setPhase("ready");
    } catch (loadError) {
      setError(
        loadError instanceof Error ? loadError.message : String(loadError)
      );
      setPhase("error");
    }
  };

  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    setSelected(next);
  };

  const addChosen = () => {
    props.onAdd(chosen.map((model) => listedModelToRow(model)));
    setSelected(new Set());
  };

  // 全部按拉取结果算，不受过滤影响；数量写在按钮上，避免歧义。
  const addAll = () => {
    props.onAdd(unfiltered.map((model) => listedModelToRow(model)));
    setSelected(new Set());
    props.onCollapse?.();
  };

  const addManual = () => {
    const id = manual.trim();
    if (id.length === 0) {
      return;
    }
    props.onAdd([manualModel(id)]);
    setManual("");
  };

  return (
    <div
      className={cn("rounded-lg border border-dashed p-3", props.className)}
      ref={rootRef}
    >
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground text-xs">
          {t("settings.provider.addModels")}
        </span>
        <div className="ml-auto flex items-center gap-1">
          {phase === "ready" && unfiltered.length > 0 ? (
            <Button onClick={addAll} size="xs" variant="ghost">
              {t("settings.provider.addAll", { count: unfiltered.length })}
            </Button>
          ) : null}
          {phase === "ready" && chosen.length > 0 ? (
            <Button onClick={addChosen} size="xs">
              {t("settings.provider.addSelected", { count: chosen.length })}
            </Button>
          ) : null}
          <Button
            disabled={phase === "loading"}
            onClick={() => void load()}
            size="xs"
            variant="ghost"
          >
            {phase === "loading" ? <Spinner /> : <RefreshCw />}
            {phase === "ready"
              ? t("settings.provider.refetch")
              : t("settings.provider.fetchModels")}
          </Button>
        </div>
      </div>

      {phase === "ready" ? (
        <div className="mt-2">
          <Input
            aria-label={t("settings.provider.filterModels")}
            className="h-7 text-xs"
            onChange={(event) => setFilter(event.target.value)}
            placeholder={t("settings.provider.filterModels")}
            value={filter}
          />
        </div>
      ) : null}

      {phase === "error" ? (
        <p className="mt-2 text-destructive text-xs" role="alert">
          {error}
        </p>
      ) : null}

      {phase === "ready" ? (
        available.length === 0 ? (
          <p className="mt-2 text-muted-foreground text-xs">
            {unfiltered.length === 0
              ? catalog.length === 0
                ? t("settings.provider.noFetchedModels")
                : t("settings.provider.allAdded")
              : t("settings.provider.noMatches")}
          </p>
        ) : (
          <div className="mt-2 max-h-44 overflow-y-auto">
            {available.map((model) => (
              <label
                className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-1 hover:bg-muted/50"
                key={model.id}
              >
                <Checkbox
                  checked={selected.has(model.id)}
                  onCheckedChange={() => toggle(model.id)}
                />
                <span className="truncate text-sm">{model.name}</span>
                {model.name === model.id ? null : (
                  <span className="truncate font-mono text-muted-foreground text-xs">
                    {model.id}
                  </span>
                )}
                {model.context === undefined ? null : (
                  <span className="ml-auto shrink-0 text-muted-foreground text-xs tabular-nums">
                    {formatContext(model.context)}
                  </span>
                )}
              </label>
            ))}
          </div>
        )
      ) : null}

      <div className="mt-2 flex items-center gap-1.5">
        <Input
          aria-label={t("settings.provider.manualModel")}
          className="h-7 text-xs"
          onChange={(event) => setManual(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              addManual();
            }
          }}
          placeholder={t("settings.provider.manualModelPlaceholder")}
          spellCheck={false}
          value={manual}
        />
        <Button
          aria-label={t("settings.provider.addModel")}
          disabled={manual.trim().length === 0}
          onClick={addManual}
          size="icon-sm"
          variant="ghost"
        >
          <PlusIcon />
        </Button>
      </div>
    </div>
  );
}
