import { useForm } from "@tanstack/react-form";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
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
import { client } from "@workspace/ui/lib/orpc";
import { PlusIcon } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { SettingFrame } from "./setting-frame";

export function ModelSettings() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);

  const listAiModelsQuery = useQuery({
    queryKey: ["listAiModels"],
    queryFn: async () => await client.aiModel.list(),
  });

  const createMutation = useMutation({
    mutationFn: async (input: Parameters<typeof client.aiModel.create>[0]) =>
      await client.aiModel.create(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["listAiModels"] });
      setDialogOpen(false);
      form.reset();
    },
  });

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
      const id = `${value.provider}/${value.model}`;
      await createMutation.mutateAsync({
        id,
        name: value.name,
        provider: value.provider,
        model: value.model,
        apiKey: value.apiKey,
        apiUrl: value.apiUrl,
        compatibleType: value.compatibleType as "openai",
        active: value.active,
      });
    },
  });

  return (
    <div className="mx-auto flex w-2xl flex-col">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="font-bold text-xl">{t("settings.model.title")}</h1>
        <Button
          onClick={() => {
            setDialogOpen(true);
          }}
        >
          <PlusIcon />
          {t("settings.model.addModel")}
        </Button>
      </div>

      <SettingFrame></SettingFrame>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("settings.model.createTitle")}</DialogTitle>
            <DialogDescription>
              {t("settings.model.createDescription")}
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
              {t("settings.model.create")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
