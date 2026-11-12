import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PROVIDER_PRESETS, slugifyProviderId } from "@workspace/shared/model";
import type { ModelProtocol, ModelRef } from "@workspace/shared/model";
import { Button } from "@workspace/ui/components/button";
import { Checkbox } from "@workspace/ui/components/checkbox";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@workspace/ui/components/dialog";
import { Field, FieldGroup, FieldLabel } from "@workspace/ui/components/field";
import { Input } from "@workspace/ui/components/input";
import {
  InputGroup,
  InputGroupInput,
  InputGroupAddon,
  InputGroupText,
} from "@workspace/ui/components/input-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select";
import { Spinner } from "@workspace/ui/components/spinner";
import { Switch } from "@workspace/ui/components/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableRow,
} from "@workspace/ui/components/table";
import { client } from "@workspace/ui/lib/orpc";
import {
  ChevronDown,
  ChevronRight,
  Pencil,
  PlusIcon,
  RefreshCw,
  Trash,
} from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { ModelLogo } from "../model-logo";
import { SettingFrame } from "./setting-frame";

type SettingsData = Awaited<ReturnType<typeof client.setting.get>>;
type ProviderRow = SettingsData["providers"][number];
type ModelRow = ProviderRow["models"][number];
type ListedModel = Awaited<
  ReturnType<typeof client.setting.listModels>
>["models"][number];

const MODALITIES = ["text", "audio", "image", "video", "pdf"] as const;
type Modality = (typeof MODALITIES)[number];

const DEFAULT_CONTEXT = 131_072;
const CONTEXT_UNIT = 1024;

/** Tokens 到界面上的 k；去掉浮点噪声。 */
function toKilotokens(tokens: number) {
  return Number((tokens / CONTEXT_UNIT).toFixed(2));
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

export function ProviderSettings() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [providerDraft, setProviderDraft] = useState<ProviderDraft | null>(
    null
  );
  const [modelDraft, setModelDraft] = useState<ModelDraft | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ProviderRow | null>(null);

  const settingsQuery = useQuery({
    queryKey: ["settings"],
    queryFn: async () => await client.setting.get(),
  });

  const providers = settingsQuery.data?.providers ?? [];

  const saveMutation = useMutation({
    mutationFn: async (input: {
      providers: ProviderRow[];
      defaultModel?: ModelRef | null;
    }) => await client.setting.update(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["settings"] });
    },
  });

  const save = async (next: ProviderRow[], defaultModel?: ModelRef | null) => {
    await saveMutation.mutateAsync({
      providers: next,
      ...(defaultModel === undefined ? {} : { defaultModel }),
    });
  };

  const toggleExpanded = (id: string) => {
    const next = new Set(expanded);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    setExpanded(next);
  };

  const patchProvider = async (id: string, patch: Partial<ProviderRow>) => {
    await save(
      providers.map((provider) =>
        provider.id === id ? { ...provider, ...patch } : provider
      )
    );
  };

  const removeProvider = async (id: string) => {
    await save(providers.filter((provider) => provider.id !== id));
    setDeleteTarget(null);
  };

  const patchModel = async (
    providerId: string,
    modelId: string,
    patch: Partial<ModelRow>
  ) => {
    await save(
      providers.map((provider) =>
        provider.id === providerId
          ? {
              ...provider,
              models: provider.models.map((model) =>
                model.id === modelId ? { ...model, ...patch } : model
              ),
            }
          : provider
      )
    );
  };

  const removeModel = async (providerId: string, modelId: string) => {
    await save(
      providers.map((provider) =>
        provider.id === providerId
          ? {
              ...provider,
              models: provider.models.filter((model) => model.id !== modelId),
            }
          : provider
      )
    );
  };

  const addModels = async (providerId: string, models: ModelRow[]) => {
    const [first] = models;
    const next = providers.map((provider) =>
      provider.id === providerId
        ? {
            ...provider,
            models: [
              ...provider.models,
              ...models.filter(
                (model) =>
                  !provider.models.some((existing) => existing.id === model.id)
              ),
            ],
          }
        : provider
    );
    // 第一个模型顺带成为默认模型：没有默认值时新会话才有东西可选。
    const needsDefault =
      (settingsQuery.data?.defaultModel ?? null) === null &&
      first !== undefined;
    await save(
      next,
      needsDefault ? { providerId, modelId: first.id } : undefined
    );
    setExpanded(new Set([...expanded, providerId]));
  };

  const uniqueProviderId = (name: string): string => {
    const base = slugifyProviderId(name);
    const taken = new Set(providers.map((provider) => provider.id));
    if (!taken.has(base)) {
      return base;
    }
    let index = 2;
    while (taken.has(`${base}-${index}`)) {
      index += 1;
    }
    return `${base}-${index}`;
  };

  return (
    <div className="mx-auto flex w-2xl flex-col">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="font-bold text-xl">{t("settings.provider.title")}</h1>
        <Button size="sm" onClick={() => setProviderDraft({ mode: "create" })}>
          <PlusIcon />
          {t("settings.provider.addProvider")}
        </Button>
      </div>

      <SettingFrame>
        <Table>
          <TableBody>
            {providers.length === 0 ? (
              <TableRow>
                <TableCell className="h-24 text-center">
                  {t("settings.provider.empty")}
                </TableCell>
              </TableRow>
            ) : (
              providers.map((provider) => (
                <ProviderRows
                  key={provider.id}
                  provider={provider}
                  expanded={expanded.has(provider.id)}
                  onToggle={() => toggleExpanded(provider.id)}
                  onActiveChange={(active) =>
                    void patchProvider(provider.id, { active })
                  }
                  onEdit={() => setProviderDraft({ mode: "edit", provider })}
                  onDelete={() => setDeleteTarget(provider)}
                  onAddModels={() =>
                    setModelDraft({ mode: "create", providerId: provider.id })
                  }
                  onModelActiveChange={(modelId, active) =>
                    void patchModel(provider.id, modelId, { active })
                  }
                  onModelEdit={(model) =>
                    setModelDraft({
                      mode: "edit",
                      providerId: provider.id,
                      model,
                    })
                  }
                  onModelDelete={(modelId) =>
                    void removeModel(provider.id, modelId)
                  }
                />
              ))
            )}
          </TableBody>
        </Table>
      </SettingFrame>

      {providerDraft ? (
        <ProviderDialog
          draft={providerDraft}
          takenIds={providers.map((provider) => provider.id)}
          onClose={() => setProviderDraft(null)}
          onSave={async (values) => {
            if (providerDraft.mode === "edit") {
              await patchProvider(providerDraft.provider.id, values);
            } else {
              const created: ProviderRow = {
                ...values,
                id: uniqueProviderId(values.name),
                active: true,
                models: [],
              };
              await save([...providers, created]);
              setExpanded(new Set([...expanded, created.id]));
            }
            setProviderDraft(null);
          }}
        />
      ) : null}

      {modelDraft ? (
        <ModelDialog
          key={`${modelDraft.providerId}:${modelDraft.mode === "edit" ? modelDraft.model.id : "new"}`}
          provider={providers.find(
            (provider) => provider.id === modelDraft.providerId
          )}
          draft={modelDraft}
          onClose={() => setModelDraft(null)}
          onSave={async (rows) => {
            await addModels(modelDraft.providerId, rows);
            setModelDraft(null);
          }}
          onEditSave={async (modelId, patch) => {
            await patchModel(modelDraft.providerId, modelId, patch);
            setModelDraft(null);
          }}
        />
      ) : null}

      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteTarget(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("settings.provider.deleteConfirm")}</DialogTitle>
            <DialogDescription>
              {t("settings.provider.deleteDescription")}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>
              {t("settings.provider.cancel")}
            </DialogClose>
            <Button
              variant="destructive"
              loading={saveMutation.isPending}
              onClick={() => {
                if (deleteTarget) {
                  void removeProvider(deleteTarget.id);
                }
              }}
            >
              {t("settings.provider.delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

type ProviderDraft =
  | { mode: "create" }
  | { mode: "edit"; provider: ProviderRow };

type ModelDraft =
  | { mode: "create"; providerId: string }
  | { mode: "edit"; providerId: string; model: ModelRow };

function ProviderRows(props: {
  provider: ProviderRow;
  expanded: boolean;
  onToggle: () => void;
  onActiveChange: (active: boolean) => void;
  onEdit: () => void;
  onDelete: () => void;
  onAddModels: () => void;
  onModelActiveChange: (modelId: string, active: boolean) => void;
  onModelEdit: (model: ModelRow) => void;
  onModelDelete: (modelId: string) => void;
}) {
  const { t } = useTranslation();
  const { provider } = props;
  const Chevron = props.expanded ? ChevronDown : ChevronRight;

  return (
    <>
      <TableRow>
        <TableCell>
          <div className="flex items-center gap-2">
            <button
              className="flex items-center gap-1 text-left"
              onClick={props.onToggle}
              type="button"
            >
              <Chevron className="size-4 text-muted-foreground" />
              <ModelLogo model={provider.name} />
              <span>{provider.name}</span>
            </button>
            <span className="text-muted-foreground text-xs">
              {provider.baseURL}
            </span>
          </div>
        </TableCell>
        <TableCell>
          <div className="flex items-center justify-end gap-1">
            <Switch
              checked={provider.active}
              onCheckedChange={props.onActiveChange}
            />
            <Button variant="ghost" size="icon-sm" onClick={props.onEdit}>
              <Pencil />
            </Button>
            <Button variant="ghost" size="icon-sm" onClick={props.onDelete}>
              <Trash />
            </Button>
          </div>
        </TableCell>
      </TableRow>

      {props.expanded
        ? provider.models.map((model) => (
            <TableRow key={`${provider.id}/${model.id}`}>
              <TableCell>
                <div className="flex items-center gap-2 pl-6">
                  <ModelLogo model={model.name} />
                  <span>{model.name}</span>
                  {(model.limit?.context ?? 0) > 0 ? (
                    <span className="text-muted-foreground text-xs">
                      {toKilotokens(model.limit?.context ?? 0)}k
                    </span>
                  ) : null}
                </div>
              </TableCell>
              <TableCell>
                <div className="flex items-center justify-end gap-1">
                  <Switch
                    checked={model.active}
                    onCheckedChange={(active) =>
                      props.onModelActiveChange(model.id, active)
                    }
                  />
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => props.onModelEdit(model)}
                  >
                    <Pencil />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => props.onModelDelete(model.id)}
                  >
                    <Trash />
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          ))
        : null}

      {props.expanded ? (
        <TableRow>
          <TableCell colSpan={2}>
            <Button
              className="ml-6"
              size="sm"
              variant="ghost"
              onClick={props.onAddModels}
            >
              <PlusIcon />
              {t("settings.provider.addModels")}
            </Button>
          </TableCell>
        </TableRow>
      ) : null}
    </>
  );
}

function ProviderDialog(props: {
  draft: ProviderDraft;
  takenIds: readonly string[];
  onClose: () => void;
  onSave: (
    values: Pick<
      ProviderRow,
      "name" | "protocol" | "baseURL" | "apiKey" | "headers"
    >
  ) => Promise<void>;
}) {
  const { t } = useTranslation();
  const editing =
    props.draft.mode === "edit" ? props.draft.provider : undefined;
  const [presetId, setPresetId] = useState<string | undefined>();
  const [name, setName] = useState(editing?.name ?? "");
  const [protocol, setProtocol] = useState<ModelProtocol>(
    editing?.protocol ?? "openai-chat"
  );
  const [baseURL, setBaseURL] = useState(editing?.baseURL ?? "");
  const [apiKey, setApiKey] = useState("");
  const [headersText, setHeadersText] = useState(
    stringifyHeaders(editing?.headers)
  );
  const [saving, setSaving] = useState(false);

  const applyPreset = (id: string | undefined) => {
    setPresetId(id);
    const preset = PROVIDER_PRESETS.find((entry) => entry.id === id);
    if (!preset) {
      return;
    }
    setName(preset.name);
    setProtocol(preset.protocol);
    setBaseURL(preset.baseURL);
    setHeadersText(stringifyHeaders(preset.headers));
  };

  // 预设自带申请地址与控制台：只填空值时这两个链接就是入口。
  const selectedPreset = PROVIDER_PRESETS.find(
    (entry) => entry.id === presetId
  );
  const canSubmit = name.trim().length > 0 && baseURL.trim().length > 0;

  const submit = async () => {
    setSaving(true);
    try {
      await props.onSave({
        name: name.trim(),
        protocol,
        baseURL: baseURL.trim(),
        // 留空表示不改：编辑时沿用已存的密钥。
        apiKey: apiKey.length > 0 ? apiKey : (editing?.apiKey ?? ""),
        headers: parseHeaders(headersText),
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {editing
              ? t("settings.provider.editTitle")
              : t("settings.provider.createTitle")}
          </DialogTitle>
          <DialogDescription>
            {t("settings.provider.createDescription")}
          </DialogDescription>
        </DialogHeader>

        <div className="-mx-4 max-h-[50vh] overflow-y-auto px-4">
          <FieldGroup>
            {editing ? null : (
              <Field>
                <FieldLabel htmlFor="provider-preset">
                  {t("settings.provider.preset")}
                </FieldLabel>
                <Select
                  items={PROVIDER_PRESETS.map((preset) => ({
                    label: preset.name,
                    value: preset.id,
                  }))}
                  value={presetId}
                  onValueChange={(value) => applyPreset(value ?? undefined)}
                >
                  <SelectTrigger id="provider-preset">
                    <SelectValue
                      placeholder={t("settings.provider.presetPlaceholder")}
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {PROVIDER_PRESETS.map((preset) => (
                      <SelectItem key={preset.id} value={preset.id}>
                        {preset.name}
                      </SelectItem>
                    ))}
                    <SelectItem value="custom">
                      {t("settings.provider.custom")}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </Field>
            )}

            <Field>
              <FieldLabel htmlFor="provider-name">
                {t("settings.provider.name")}
              </FieldLabel>
              <Input
                id="provider-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder={t("settings.provider.namePlaceholder")}
              />
            </Field>

            <Field>
              <FieldLabel htmlFor="provider-protocol">
                {t("settings.provider.protocol")}
              </FieldLabel>
              <Select
                items={[
                  {
                    label: t("settings.provider.protocols.openai-chat"),
                    value: "openai-chat",
                  },
                  {
                    label: t("settings.provider.protocols.openai-responses"),
                    value: "openai-responses",
                  },
                ]}
                value={protocol}
                onValueChange={(value) => {
                  if (value) {
                    setProtocol(value);
                  }
                }}
              >
                <SelectTrigger id="provider-protocol">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="openai-chat">
                    {t("settings.provider.protocols.openai-chat")}
                  </SelectItem>
                  <SelectItem value="openai-responses">
                    {t("settings.provider.protocols.openai-responses")}
                  </SelectItem>
                </SelectContent>
              </Select>
            </Field>

            <Field>
              <FieldLabel htmlFor="provider-base-url">
                {t("settings.provider.baseURL")}
              </FieldLabel>
              <Input
                id="provider-base-url"
                value={baseURL}
                onChange={(event) => setBaseURL(event.target.value)}
                placeholder="https://api.example.com/v1"
              />
            </Field>

            <Field>
              <FieldLabel htmlFor="provider-api-key">
                {t("settings.provider.apiKey")}
              </FieldLabel>
              <Input
                id="provider-api-key"
                type="password"
                autoComplete="off"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder={
                  editing?.apiKey
                    ? t("settings.provider.apiKeyUnchanged")
                    : t("settings.provider.apiKeyPlaceholder")
                }
              />
              {selectedPreset ? (
                <div className="flex gap-3 text-xs">
                  <a
                    className="underline"
                    href={selectedPreset.keysURL}
                    rel="noreferrer"
                    target="_blank"
                  >
                    {t("settings.provider.getKey")}
                  </a>
                  <a
                    className="underline"
                    href={selectedPreset.website}
                    rel="noreferrer"
                    target="_blank"
                  >
                    {t("settings.provider.console")}
                  </a>
                </div>
              ) : null}
            </Field>

            <Field>
              <FieldLabel htmlFor="provider-headers">
                {t("settings.provider.headers")}
              </FieldLabel>
              <textarea
                aria-label={t("settings.provider.headers")}
                className="min-h-16 w-full rounded-md border border-input bg-transparent p-2 font-mono text-xs"
                id="provider-headers"
                value={headersText}
                onChange={(event) => setHeadersText(event.target.value)}
                placeholder={t("settings.provider.headersPlaceholder")}
              />
            </Field>
          </FieldGroup>
        </div>

        <DialogFooter>
          <DialogClose render={<Button type="button" variant="outline" />}>
            {t("settings.provider.cancel")}
          </DialogClose>
          <Button disabled={!canSubmit || saving} onClick={() => void submit()}>
            {saving && <Spinner data-icon="inline-start" />}
            {editing
              ? t("settings.provider.update")
              : t("settings.provider.create")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ModelDialog(props: {
  provider: ProviderRow | undefined;
  draft: ModelDraft;
  onClose: () => void;
  onSave: (rows: ModelRow[]) => Promise<void>;
  onEditSave: (modelId: string, patch: Partial<ModelRow>) => Promise<void>;
}) {
  const { provider } = props;
  const editing = props.draft.mode === "edit" ? props.draft.model : undefined;

  if (editing) {
    return (
      <ModelEditDialog
        model={editing}
        onClose={props.onClose}
        onSave={(patch) => props.onEditSave(editing.id, patch)}
      />
    );
  }

  return (
    <ModelPickerDialog
      provider={provider}
      onClose={props.onClose}
      onSave={props.onSave}
    />
  );
}

function ModelPickRow(props: {
  model: ListedModel;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2 py-1">
      <Checkbox checked={props.checked} onCheckedChange={props.onToggle} />
      <span>{props.model.name}</span>
      <span className="text-muted-foreground text-xs">{props.model.id}</span>
      {props.model.context ? (
        <span className="text-muted-foreground text-xs">
          {Math.round(props.model.context / 1000)}k
        </span>
      ) : null}
    </label>
  );
}

/** 从供应商拉取模型列表并勾选；拉不到时退回手填。 */
function ModelPickerDialog(props: {
  provider: ProviderRow | undefined;
  onClose: () => void;
  onSave: (rows: ModelRow[]) => Promise<void>;
}) {
  const { t } = useTranslation();
  const { provider } = props;
  const [listed, setListed] = useState<ListedModel[]>([]);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [manual, setManual] = useState("");
  const [listError, setListError] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const fetchModels = async () => {
    if (!provider) {
      return;
    }
    setLoading(true);
    setListError(undefined);
    try {
      const { models } = await client.setting.listModels({
        baseURL: provider.baseURL,
        apiKey: provider.apiKey,
        ...(provider.headers ? { headers: provider.headers } : {}),
      });
      setListed(models);
    } catch (error) {
      setListError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  };

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const added = new Set(provider?.models.map((model) => model.id));
    return listed
      .filter((model) => !added.has(model.id))
      .filter(
        (model) =>
          needle.length === 0 ||
          model.id.toLowerCase().includes(needle) ||
          model.name.toLowerCase().includes(needle)
      );
  }, [listed, filter, provider]);

  const rows = useMemo(() => {
    const chosen = listed.filter((model) => selected.has(model.id));
    if (manual.trim().length > 0) {
      chosen.push({ id: manual.trim(), name: manual.trim() });
    }
    return chosen.map((model) => ({
      id: model.id,
      name: model.name,
      active: true,
      reasoning: true,
      modalities: {
        input: model.input ?? ["text", "image"],
        output: model.output ?? ["text"],
      },
      limit: { context: model.context ?? DEFAULT_CONTEXT },
    }));
  }, [listed, selected, manual]);

  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    setSelected(next);
  };

  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("settings.provider.addModelsTitle")}</DialogTitle>
          <DialogDescription>{provider?.name}</DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2">
          <Input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder={t("settings.provider.filterModels")}
          />
          <Button
            disabled={loading}
            variant="secondary"
            onClick={() => void fetchModels()}
          >
            {loading ? <Spinner /> : <RefreshCw />}
            {t("settings.provider.fetchModels")}
          </Button>
        </div>

        {listError ? (
          <p className="text-destructive text-xs">{listError}</p>
        ) : null}

        <div className="-mx-4 max-h-[40vh] overflow-y-auto px-4">
          {visible.length === 0 ? (
            <p className="py-2 text-muted-foreground text-xs">
              {t("settings.provider.noFetchedModels")}
            </p>
          ) : (
            visible.map((model) => (
              <ModelPickRow
                key={model.id}
                model={model}
                checked={selected.has(model.id)}
                onToggle={() => toggle(model.id)}
              />
            ))
          )}
        </div>

        <Field>
          <FieldLabel htmlFor="manual-model">
            {t("settings.provider.manualModel")}
          </FieldLabel>
          <Input
            id="manual-model"
            value={manual}
            onChange={(event) => setManual(event.target.value)}
            placeholder={t("settings.provider.manualModelPlaceholder")}
          />
        </Field>

        <DialogFooter>
          <DialogClose render={<Button type="button" variant="outline" />}>
            {t("settings.provider.cancel")}
          </DialogClose>
          <Button
            disabled={rows.length === 0 || saving}
            onClick={() => {
              setSaving(true);
              void props.onSave(rows).finally(() => setSaving(false));
            }}
          >
            {saving && <Spinner data-icon="inline-start" />}
            {t("settings.provider.addSelected", { count: rows.length })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ModalityCheckboxes(props: {
  label: string;
  value: readonly Modality[];
  onChange: (next: Modality[]) => void;
}) {
  return (
    <Field>
      <FieldLabel>{props.label}</FieldLabel>
      <div className="flex flex-wrap gap-3">
        {MODALITIES.map((modality) => (
          <label className="flex items-center gap-1 text-xs" key={modality}>
            <Checkbox
              checked={props.value.includes(modality)}
              onCheckedChange={(checked) =>
                props.onChange(
                  checked
                    ? [...props.value, modality]
                    : props.value.filter((entry) => entry !== modality)
                )
              }
            />
            {modality}
          </label>
        ))}
      </div>
    </Field>
  );
}

function ModelEditDialog(props: {
  model: ModelRow;
  onClose: () => void;
  onSave: (patch: Partial<ModelRow>) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(props.model.name);
  const [context, setContext] = useState(
    String(toKilotokens(props.model.limit?.context ?? DEFAULT_CONTEXT))
  );
  const [modalities, setModalities] = useState({
    input: props.model.modalities?.input ?? ["text", "image"],
    output: props.model.modalities?.output ?? ["text"],
  });
  const [reasoning, setReasoning] = useState(props.model.reasoning ?? true);
  const [saving, setSaving] = useState(false);

  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("settings.provider.editModelTitle")}</DialogTitle>
          <DialogDescription>{props.model.id}</DialogDescription>
        </DialogHeader>

        <div className="-mx-4 max-h-[50vh] overflow-y-auto px-4">
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="model-name">
                {t("settings.provider.name")}
              </FieldLabel>
              <Input
                id="model-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>

            <Field>
              <FieldLabel htmlFor="model-context">
                {t("modelCapability.contextWindow")}
              </FieldLabel>
              <InputGroup>
                <InputGroupInput
                  id="model-context"
                  inputMode="decimal"
                  value={context}
                  onChange={(event) => setContext(event.target.value)}
                />
                <InputGroupAddon align="inline-end">
                  <InputGroupText>k</InputGroupText>
                </InputGroupAddon>
              </InputGroup>
            </Field>

            <ModalityCheckboxes
              label={t("modelCapability.input")}
              value={modalities.input}
              onChange={(input) => setModalities({ ...modalities, input })}
            />
            <ModalityCheckboxes
              label={t("modelCapability.output")}
              value={modalities.output}
              onChange={(output) => setModalities({ ...modalities, output })}
            />

            <Field orientation="horizontal">
              <Checkbox
                checked={reasoning}
                onCheckedChange={(checked) => setReasoning(checked)}
              />
              <FieldLabel>{t("modelCapability.reasoning")}</FieldLabel>
            </Field>
          </FieldGroup>
        </div>

        <DialogFooter>
          <DialogClose render={<Button type="button" variant="outline" />}>
            {t("settings.provider.cancel")}
          </DialogClose>
          <Button
            disabled={saving || name.trim().length === 0}
            onClick={() => {
              setSaving(true);
              const kilotokens = Number(context.trim());
              void props
                .onSave({
                  name: name.trim(),
                  modalities,
                  reasoning,
                  limit: {
                    context: Number.isFinite(kilotokens)
                      ? Math.round(kilotokens * CONTEXT_UNIT)
                      : DEFAULT_CONTEXT,
                  },
                })
                .finally(() => setSaving(false));
            }}
          >
            {saving && <Spinner data-icon="inline-start" />}
            {t("settings.provider.update")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
