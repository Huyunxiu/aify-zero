import { useForm } from "@tanstack/react-form";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
} from "@tanstack/react-table";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@workspace/ui/components/alert-dialog";
import { Button } from "@workspace/ui/components/button";
import { Checkbox } from "@workspace/ui/components/checkbox";
import {
  Combobox,
  ComboboxChip,
  ComboboxChips,
  ComboboxChipsInput,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxValue,
} from "@workspace/ui/components/combobox";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@workspace/ui/components/dialog";
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@workspace/ui/components/field";
import { Input } from "@workspace/ui/components/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
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
import { Pencil, PlusIcon, Trash } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { ModelLogo } from "../model-logo";
import { SettingFrame } from "./setting-frame";

const MODALITIES = ["text", "audio", "image", "video", "pdf"] as const;

type Modality = (typeof MODALITIES)[number];

interface ModalityItem {
  value: Modality;
  label: string;
}

const DEFAULT_MODALITIES: { input: Modality[]; output: Modality[] } = {
  input: ["text", "image"],
  output: ["text"],
};

// Context window (model limit.context) is stored in tokens but edited in "k".
const CONTEXT_UNIT = 1024;
const DEFAULT_CONTEXT = 131_072;

/** Tokens to the "k" the field is typed in, trimming float noise (97.66, not 97.65625). */
function toKilotokens(tokens: number) {
  return Number((tokens / CONTEXT_UNIT).toFixed(2));
}

function ModalityCombobox({
  label,
  items,
  value,
  onValueChange,
}: {
  label: string;
  items: ModalityItem[];
  value: ModalityItem[];
  onValueChange: (items: ModalityItem[]) => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <FieldLabel>{label}</FieldLabel>
      <Combobox
        items={items}
        multiple
        value={value}
        onValueChange={onValueChange}
      >
        <ComboboxChips>
          <ComboboxValue>
            {(selected: ModalityItem[]) => (
              <>
                {selected.map((item) => (
                  <ComboboxChip key={item.value}>{item.label}</ComboboxChip>
                ))}
                <ComboboxChipsInput />
              </>
            )}
          </ComboboxValue>
        </ComboboxChips>
        <ComboboxContent>
          <ComboboxList>
            {(item: ModalityItem) => (
              <ComboboxItem key={item.value} value={item}>
                {item.label}
              </ComboboxItem>
            )}
          </ComboboxList>
          <ComboboxEmpty>{t("modelCapability.noResults")}</ComboboxEmpty>
        </ComboboxContent>
      </Combobox>
    </>
  );
}

/** Context window in thousands of tokens. The text is held locally so the field
 *  can be emptied while retyping; only numbers are committed. */
function ContextInput({
  id,
  value,
  onValueChange,
  onBlur,
  "aria-invalid": ariaInvalid,
}: {
  id: string;
  value: number;
  onValueChange: (value: number) => void;
  onBlur?: () => void;
  "aria-invalid"?: boolean;
}) {
  const [text, setText] = useState(() => String(toKilotokens(value)));

  // Follow dialog resets without fighting the typed text: anything that already
  // means the field's value is left alone, so "128." survives while typed.
  useEffect(() => {
    setText((prev) =>
      Number(prev) * CONTEXT_UNIT === value ? prev : String(toKilotokens(value))
    );
  }, [value]);

  return (
    <InputGroup>
      <InputGroupInput
        id={id}
        name={id}
        type="text"
        inputMode="decimal"
        value={text}
        aria-invalid={ariaInvalid}
        onChange={(e) => {
          const next = e.target.value;
          setText(next);
          const kilotokens = Number(next.trim());
          if (next.trim() !== "" && !Number.isNaN(kilotokens)) {
            onValueChange(kilotokens * CONTEXT_UNIT);
          }
        }}
        onBlur={() => {
          setText(String(toKilotokens(value)));
          onBlur?.();
        }}
      />
      <InputGroupAddon align="inline-end">
        <InputGroupText>k</InputGroupText>
      </InputGroupAddon>
    </InputGroup>
  );
}

export function ModelSettings() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  const modalityItems = useMemo<ModalityItem[]>(
    () =>
      MODALITIES.map((modality) => ({
        value: modality,
        label: t(`modelCapability.modalities.${modality}`),
      })),
    [t]
  );

  const openCreateDialog = () => {
    setEditingId(null);
    form.reset();
    setDialogOpen(true);
  };

  type AiModelRow = NonNullable<
    Awaited<ReturnType<typeof client.setting.get>>["models"]
  >[number];

  const openEditDialog = (model: AiModelRow) => {
    setEditingId(model.id);
    form.reset(
      {
        name: model.name ?? "",
        provider: model.provider ?? "",
        model: model.model ?? "",
        apiKey: model.apiKey ?? "",
        apiUrl: model.apiUrl ?? "",
        compatibleType: model.compatibleType ?? "openai",
        active: model.active ?? true,
        reasoning: !!model.reasoning,
        modalities: model.modalities ?? DEFAULT_MODALITIES,
        limit: { context: model.limit?.context ?? DEFAULT_CONTEXT },
      },
      {
        keepDefaultValues: true,
      }
    );
    setDialogOpen(true);
  };

  const listAiModelsQuery = useQuery({
    queryKey: ["settings"],
    queryFn: async () => await client.setting.get(),
    select: (data) => data.models,
  });

  const saveSettingsMutation = useMutation({
    mutationFn: async (models: AiModelRow[]) =>
      await client.setting.update({ models }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["settings"] });
    },
  });

  const createAiModel = async (input: AiModelRow) => {
    const currentModels = listAiModelsQuery.data ?? [];
    await saveSettingsMutation.mutateAsync([...currentModels, input]);
    setDialogOpen(false);
    form.reset();
  };

  const updateAiModel = async (id: string, input: Partial<AiModelRow>) => {
    const currentModels = listAiModelsQuery.data ?? [];
    await saveSettingsMutation.mutateAsync(
      currentModels.map((m) => (m.id === id ? { ...m, ...input } : m))
    );
    setDialogOpen(false);
    setEditingId(null);
    form.reset();
  };

  const deleteAiModel = async (id: string) => {
    const currentModels = listAiModelsQuery.data ?? [];
    await saveSettingsMutation.mutateAsync(
      currentModels.filter((m) => m.id !== id)
    );
    setDeleteDialogOpen(false);
  };

  const columns: ColumnDef<AiModelRow>[] = [
    {
      accessorKey: "name",
      cell: ({ row }) => (
        <div className="flex items-center gap-1">
          <ModelLogo model={row.original.name} />
          <span>{row.original.name}</span>
        </div>
      ),
    },
    {
      id: "actions",
      cell: ({ row }) => (
        <div className="flex items-center justify-end gap-1">
          <Switch
            checked={row.original.active}
            onCheckedChange={(checked) => {
              void updateAiModel(row.original.id, { active: checked });
            }}
          />
          <Button
            variant="ghost"
            size="icon-sm"
            disabled={saveSettingsMutation.isPending}
            onClick={() => {
              openEditDialog(row.original);
            }}
          >
            <Pencil />
          </Button>
          <AlertDialog
            open={deleteDialogOpen}
            onOpenChange={(open) => {
              setDeleteDialogOpen(open);
            }}
          >
            <AlertDialogTrigger
              render={
                <Button variant="ghost" size="icon-sm">
                  <Trash />
                </Button>
              }
            ></AlertDialogTrigger>
            <AlertDialogContent size="sm">
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {t("settings.model.deleteConfirm")}
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {t("settings.model.deleteDescription")}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>
                  {t("settings.model.cancel")}
                </AlertDialogCancel>
                <AlertDialogAction
                  variant="destructive"
                  loading={saveSettingsMutation.isPending}
                  disabled={saveSettingsMutation.isPending}
                  onClick={() => {
                    void deleteAiModel(row.original.id);
                  }}
                >
                  {t("settings.model.delete")}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      ),
    },
  ];

  const form = useForm({
    defaultValues: {
      name: "",
      provider: "",
      model: "",
      apiKey: "",
      apiUrl: "",
      compatibleType: "openai",
      active: true,
      reasoning: true,
      modalities: DEFAULT_MODALITIES,
      limit: { context: DEFAULT_CONTEXT },
    },
    onSubmit: async ({ value }) => {
      if (editingId) {
        await updateAiModel(editingId, {
          name: value.name,
          provider: value.provider,
          model: value.model,
          apiKey: value.apiKey,
          apiUrl: value.apiUrl,
          compatibleType: value.compatibleType as "openai",
          active: value.active,
          reasoning: value.reasoning,
          modalities: value.modalities,
          limit: value.limit,
        });
      } else {
        const id = `${value.provider}/${value.model}`;
        await createAiModel({
          id,
          name: value.name,
          provider: value.provider,
          model: value.model,
          apiKey: value.apiKey,
          apiUrl: value.apiUrl,
          compatibleType: value.compatibleType as "openai",
          active: value.active,
          reasoning: value.reasoning,
          modalities: value.modalities,
          limit: value.limit,
        });
      }
    },
  });

  return (
    <div className="mx-auto flex w-2xl flex-col">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="font-bold text-xl">{t("settings.model.title")}</h1>
        <Button size="sm" onClick={openCreateDialog}>
          <PlusIcon />
          {t("settings.model.addModel")}
        </Button>
      </div>

      <SettingFrame>
        <DataTable columns={columns} data={listAiModelsQuery.data ?? []} />
      </SettingFrame>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {editingId
                ? t("settings.model.editTitle")
                : t("settings.model.createTitle")}
            </DialogTitle>
            <DialogDescription>
              {editingId
                ? t("settings.model.editDescription")
                : t("settings.model.createDescription")}
            </DialogDescription>
          </DialogHeader>

          <div className="-mx-4 px-4 scroll-fade no-scrollbar max-h-[50vh] overflow-y-auto">
            <form
              id="create-ai-model-dialog"
              onSubmit={(e) => {
                e.preventDefault();
                e.stopPropagation();
                void form.handleSubmit();
              }}
            >
              <FieldGroup>
                <form.Field
                  name="name"
                  validators={{
                    onChange: ({ value }) =>
                      !value ? t("settings.model.nameRequired") : undefined,
                  }}
                >
                  {(field) => {
                    const isInvalid =
                      field.state.meta.isTouched && !field.state.meta.isValid;
                    const errors = field.state.meta.errors.map((message) => ({
                      message,
                    }));
                    return (
                      <Field data-invalid={isInvalid}>
                        <FieldLabel htmlFor={field.name}>
                          {t("settings.model.name")}
                        </FieldLabel>
                        <Input
                          id={field.name}
                          name={field.name}
                          value={field.state.value}
                          onBlur={field.handleBlur}
                          onChange={(e) => {
                            field.handleChange(e.target.value);
                          }}
                          placeholder={t("settings.model.namePlaceholder")}
                          aria-invalid={isInvalid}
                        />
                        {isInvalid && <FieldError errors={errors} />}
                      </Field>
                    );
                  }}
                </form.Field>

                <form.Field
                  name="provider"
                  validators={{
                    onChange: ({ value }) =>
                      !value ? t("settings.model.providerRequired") : undefined,
                  }}
                >
                  {(field) => {
                    const isInvalid =
                      field.state.meta.isTouched && !field.state.meta.isValid;
                    const errors = field.state.meta.errors.map((message) => ({
                      message,
                    }));
                    return (
                      <Field data-invalid={isInvalid}>
                        <FieldLabel htmlFor={field.name}>
                          {t("settings.model.provider")}
                        </FieldLabel>
                        <Input
                          id={field.name}
                          name={field.name}
                          value={field.state.value}
                          onBlur={field.handleBlur}
                          onChange={(e) => {
                            field.handleChange(e.target.value);
                          }}
                          placeholder={t("settings.model.providerPlaceholder")}
                          aria-invalid={isInvalid}
                        />
                        {isInvalid && <FieldError errors={errors} />}
                      </Field>
                    );
                  }}
                </form.Field>

                <form.Field
                  name="model"
                  validators={{
                    onChange: ({ value }) =>
                      !value
                        ? t("settings.model.modelNameRequired")
                        : undefined,
                  }}
                >
                  {(field) => {
                    const isInvalid =
                      field.state.meta.isTouched && !field.state.meta.isValid;
                    const errors = field.state.meta.errors.map((message) => ({
                      message,
                    }));
                    return (
                      <Field data-invalid={isInvalid}>
                        <FieldLabel htmlFor={field.name}>
                          {t("settings.model.modelName")}
                        </FieldLabel>
                        <Input
                          id={field.name}
                          name={field.name}
                          value={field.state.value}
                          onBlur={field.handleBlur}
                          onChange={(e) => {
                            field.handleChange(e.target.value);
                          }}
                          placeholder={t("settings.model.modelNamePlaceholder")}
                          aria-invalid={isInvalid}
                        />
                        {isInvalid && <FieldError errors={errors} />}
                      </Field>
                    );
                  }}
                </form.Field>

                <form.Field name="apiUrl">
                  {(field) => {
                    const isInvalid =
                      field.state.meta.isTouched && !field.state.meta.isValid;
                    const errors = field.state.meta.errors.map((message) => ({
                      message,
                    }));
                    return (
                      <Field data-invalid={isInvalid}>
                        <FieldLabel htmlFor={field.name}>
                          {t("settings.model.apiUrl")}
                        </FieldLabel>
                        <Input
                          id={field.name}
                          name={field.name}
                          value={field.state.value}
                          onBlur={field.handleBlur}
                          onChange={(e) => {
                            field.handleChange(e.target.value);
                          }}
                          placeholder={t("settings.model.apiUrlPlaceholder")}
                          aria-invalid={isInvalid}
                        />
                        {isInvalid && <FieldError errors={errors} />}
                      </Field>
                    );
                  }}
                </form.Field>

                <form.Field name="apiKey">
                  {(field) => {
                    const isInvalid =
                      field.state.meta.isTouched && !field.state.meta.isValid;
                    const errors = field.state.meta.errors.map((message) => ({
                      message,
                    }));
                    return (
                      <Field data-invalid={isInvalid}>
                        <FieldLabel htmlFor={field.name}>
                          {t("settings.model.apiKey")}
                        </FieldLabel>
                        <Input
                          id={field.name}
                          name={field.name}
                          value={field.state.value}
                          onBlur={field.handleBlur}
                          onChange={(e) => {
                            field.handleChange(e.target.value);
                          }}
                          placeholder={t("settings.model.apiKeyPlaceholder")}
                          aria-invalid={isInvalid}
                        />
                        {isInvalid && <FieldError errors={errors} />}
                      </Field>
                    );
                  }}
                </form.Field>

                <form.Field name="compatibleType">
                  {(field) => {
                    const isInvalid =
                      field.state.meta.isTouched && !field.state.meta.isValid;
                    const errors = field.state.meta.errors.map((message) => ({
                      message,
                    }));
                    return (
                      <Field data-invalid={isInvalid}>
                        <FieldLabel htmlFor={field.name}>
                          {t("settings.model.compatibleType")}
                        </FieldLabel>
                        <Select
                          items={[
                            {
                              label: "OpenAI",
                              value: "openai",
                            },
                          ]}
                          value={field.state.value}
                          onValueChange={(value) => {
                            if (value) {
                              field.handleChange(value);
                            }
                          }}
                        >
                          <SelectTrigger
                            id={field.name}
                            aria-invalid={isInvalid}
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="openai">OpenAI</SelectItem>
                          </SelectContent>
                        </Select>
                        {isInvalid && <FieldError errors={errors} />}
                      </Field>
                    );
                  }}
                </form.Field>

                <form.Field name="limit.context">
                  {(field) => {
                    const isInvalid =
                      field.state.meta.isTouched && !field.state.meta.isValid;
                    const errors = field.state.meta.errors.map((message) => ({
                      message,
                    }));
                    return (
                      <Field data-invalid={isInvalid}>
                        <FieldLabel htmlFor={field.name}>
                          {t("modelCapability.contextWindow")}
                        </FieldLabel>
                        <ContextInput
                          id={field.name}
                          value={field.state.value}
                          onValueChange={field.handleChange}
                          onBlur={field.handleBlur}
                          aria-invalid={isInvalid}
                        />
                        {isInvalid && <FieldError errors={errors} />}
                      </Field>
                    );
                  }}
                </form.Field>

                <form.Field name="modalities">
                  {(field) => {
                    const isInvalid =
                      field.state.meta.isTouched && !field.state.meta.isValid;
                    const errors = field.state.meta.errors.map((message) => ({
                      message,
                    }));
                    return (
                      <>
                        <Field data-invalid={isInvalid}>
                          <ModalityCombobox
                            label={t("modelCapability.input")}
                            items={modalityItems}
                            value={modalityItems.filter((item) =>
                              field.state.value.input.includes(item.value)
                            )}
                            onValueChange={(input) => {
                              field.handleChange({
                                ...field.state.value,
                                input: input.map((item) => item.value),
                              });
                            }}
                          />
                          {isInvalid && <FieldError errors={errors} />}
                        </Field>
                        <Field data-invalid={isInvalid}>
                          <ModalityCombobox
                            label={t("modelCapability.output")}
                            items={modalityItems}
                            value={modalityItems.filter((item) =>
                              field.state.value.output.includes(item.value)
                            )}
                            onValueChange={(output) => {
                              field.handleChange({
                                ...field.state.value,
                                output: output.map((item) => item.value),
                              });
                            }}
                          />
                          {isInvalid && <FieldError errors={errors} />}
                        </Field>
                      </>
                    );
                  }}
                </form.Field>

                <form.Field name="reasoning">
                  {(field) => {
                    const isInvalid =
                      field.state.meta.isTouched && !field.state.meta.isValid;
                    const errors = field.state.meta.errors.map((message) => ({
                      message,
                    }));
                    return (
                      <Field orientation="horizontal" data-invalid={isInvalid}>
                        <Checkbox
                          id={field.name}
                          name={field.name}
                          checked={field.state.value}
                          onCheckedChange={(checked) =>
                            field.handleChange(checked)
                          }
                        />
                        <FieldLabel htmlFor={field.name}>
                          {t("modelCapability.reasoning")}
                        </FieldLabel>
                        {isInvalid && <FieldError errors={errors} />}
                      </Field>
                    );
                  }}
                </form.Field>
              </FieldGroup>
            </form>
          </div>

          <DialogFooter>
            <DialogClose
              className="min-w-20"
              render={<Button type="button" variant="outline" />}
            >
              {t("settings.model.cancel")}
            </DialogClose>
            <Button
              className="min-w-20"
              type="submit"
              form="create-ai-model-dialog"
              disabled={!form.state.canSubmit || form.state.isSubmitting}
            >
              {form.state.isSubmitting && <Spinner data-icon="inline-start" />}
              {editingId
                ? t("settings.model.update")
                : t("settings.model.create")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

interface DataTableProps<TData, TValue> {
  columns: ColumnDef<TData, TValue>[];
  data: TData[];
}

export function DataTable<TData, TValue>({
  columns,
  data,
}: DataTableProps<TData, TValue>) {
  const table = useReactTable({
    data,
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  return (
    <div className="overflow-hidden w-full">
      <Table>
        <TableBody>
          {table.getRowModel().rows?.length ? (
            table.getRowModel().rows.map((row) => (
              <TableRow
                key={row.id}
                data-state={row.getIsSelected() && "selected"}
              >
                {row.getVisibleCells().map((cell) => (
                  <TableCell key={cell.id}>
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </TableCell>
                ))}
              </TableRow>
            ))
          ) : (
            <TableRow>
              <TableCell colSpan={columns.length} className="h-24 text-center">
                No results.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}
