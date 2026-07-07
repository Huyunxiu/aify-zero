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
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { SettingFrame } from "./setting-frame";

export function ModelSettings() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  const openCreateDialog = () => {
    setEditingId(null);
    form.reset();
    setDialogOpen(true);
  };

  type AiModelRow = NonNullable<
    Awaited<ReturnType<typeof client.aiModel.list>>
  >[number];
  type AiModelInput = Parameters<typeof client.aiModel.create>[0];

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
      },
      {
        keepDefaultValues: true,
      }
    );
    setDialogOpen(true);
  };

  const listAiModelsQuery = useQuery({
    queryKey: ["listAiModels"],
    queryFn: async () => await client.aiModel.list(),
  });

  const createAiModelMutation = useMutation({
    mutationFn: async (input: AiModelInput) =>
      await client.aiModel.create(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["listAiModels"] });
      setDialogOpen(false);
      form.reset();
    },
  });

  const updateAiModelMutation = useMutation({
    mutationFn: async (input: Parameters<typeof client.aiModel.update>[0]) =>
      await client.aiModel.update(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["listAiModels"] });
      setDialogOpen(false);
      setEditingId(null);
      form.reset();
    },
  });

  const deleteAiModelMutation = useMutation({
    mutationFn: async (id: string) => await client.aiModel.delete({ id }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["listAiModels"] });
    },
  });

  const columns: ColumnDef<AiModelRow>[] = [
    {
      accessorKey: "name",
    },
    {
      id: "actions",
      cell: ({ row }) => (
        <div className="flex items-center justify-end gap-2">
          <Switch
            checked={row.original.active}
            onCheckedChange={(checked) => {
              updateAiModelMutation.mutate({
                id: row.original.id,
                active: checked,
              });
            }}
          />
          <Button
            variant="ghost"
            size="icon-sm"
            disabled={deleteAiModelMutation.isPending}
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
                <Button variant="destructive" size="icon-sm">
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
                  loading={deleteAiModelMutation.isPending}
                  disabled={deleteAiModelMutation.isPending}
                  onClick={() => {
                    deleteAiModelMutation.mutate(row.original.id);
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
    },
    onSubmit: async ({ value }) => {
      if (editingId) {
        await updateAiModelMutation.mutateAsync({
          id: editingId,
          name: value.name,
          provider: value.provider,
          model: value.model,
          apiKey: value.apiKey,
          apiUrl: value.apiUrl,
          compatibleType: value.compatibleType as "openai",
          active: value.active,
        });
      } else {
        const id = `${value.provider}/${value.model}`;
        await createAiModelMutation.mutateAsync({
          id,
          name: value.name,
          provider: value.provider,
          model: value.model,
          apiKey: value.apiKey,
          apiUrl: value.apiUrl,
          compatibleType: value.compatibleType as "openai",
          active: value.active,
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
                    !value ? t("settings.model.modelNameRequired") : undefined,
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
                        <SelectTrigger id={field.name} aria-invalid={isInvalid}>
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
            </FieldGroup>
          </form>

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
