import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { getErrorMessage } from "@workspace/shared/errors";
import { ModelEffort } from "@workspace/shared/constants";
import type { ModelRef } from "@workspace/shared/model";
import { XIcon } from "lucide-react";
import { useId, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { useTranslation } from "react-i18next";

import { ModelSelect } from "../elements/model-select";
import { flattenModels } from "../lib/models";
import { client } from "../lib/orpc";
import { Button } from "./button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./dialog";
import { Field, FieldError, FieldGroup, FieldLabel } from "./field";
import { Input } from "./input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./select";

export type BotCreateDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

const NO_PROJECT_VALUE = "__none__";

/** Minimal Bot creation modal storing name, avatar, description, default Project, and default Model. */
export function BotCreateDialog({ open, onOpenChange }: BotCreateDialogProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const formId = useId();

  const [name, setName] = useState("");
  const [avatar, setAvatar] = useState("");
  const [description, setDescription] = useState("");
  const [defaultProjectId, setDefaultProjectId] = useState<string | null>(null);
  const [defaultModel, setDefaultModel] = useState<ModelRef | undefined>();
  const [defaultEffort, setDefaultEffort] = useState<ModelEffort>(
    ModelEffort.Default
  );
  const [nameError, setNameError] = useState<string>();

  const projectsQuery = useQuery({
    queryKey: ["list_projects"],
    queryFn: () => client.project.list(),
    enabled: open,
  });

  const settingsQuery = useQuery({
    queryKey: ["settings"],
    queryFn: async () => await client.setting.get(),
    enabled: open,
  });

  const models = useMemo(
    () => flattenModels(settingsQuery.data?.providers ?? []),
    [settingsQuery.data?.providers]
  );

  const createMutation = useMutation({
    mutationFn: async () =>
      await client.bot.create({
        name: name.trim(),
        ...(avatar.trim() ? { avatar: avatar.trim() } : {}),
        ...(description.trim() ? { description: description.trim() } : {}),
        defaultProjectId,
        defaultModel: defaultModel ?? null,
        defaultEffort: defaultModel ? defaultEffort : null,
      }),
    onSuccess: async ({ bot }) => {
      await queryClient.invalidateQueries({ queryKey: ["list_bots"] });
      onOpenChange(false);
      await navigate({
        to: "/bots/$botId",
        params: { botId: bot.id },
      });
    },
  });

  const resetForm = () => {
    setName("");
    setAvatar("");
    setDescription("");
    setDefaultProjectId(null);
    setDefaultModel(undefined);
    setDefaultEffort(ModelEffort.Default);
    setNameError(undefined);
    createMutation.reset();
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (createMutation.isPending) {
      return;
    }

    if (!name.trim()) {
      setNameError(t("bots.createDialog.nameRequired"));
      return;
    }

    setNameError(undefined);
    createMutation.mutate();
  };

  const projectsData = projectsQuery.data?.projects;
  const projectItems = useMemo(
    () => [
      { value: NO_PROJECT_VALUE, label: t("projects.none") },
      ...(projectsData ?? []).map((project) => ({
        value: project.id,
        label: project.name,
      })),
    ],
    [projectsData, t]
  );
  const projects = projectsData ?? [];

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          resetForm();
        }
        onOpenChange(nextOpen);
      }}
    >
      <DialogContent size="medium">
        <DialogHeader>
          <DialogTitle>{t("bots.createDialog.title")}</DialogTitle>
        </DialogHeader>

        <form id={formId} onSubmit={handleSubmit} noValidate>
          <FieldGroup>
            <div className="grid grid-cols-[5rem_1fr] gap-3">
              <Field>
                <FieldLabel htmlFor={`${formId}-avatar`}>
                  {t("bots.fields.avatar")}
                </FieldLabel>
                <Input
                  id={`${formId}-avatar`}
                  value={avatar}
                  maxLength={8}
                  placeholder="🤖"
                  className="text-center"
                  onChange={(event) => {
                    setAvatar(event.target.value);
                  }}
                />
              </Field>
              <Field data-invalid={Boolean(nameError)}>
                <FieldLabel htmlFor={`${formId}-name`}>
                  {t("bots.fields.name")}
                </FieldLabel>
                <Input
                  id={`${formId}-name`}
                  value={name}
                  placeholder={t("bots.createDialog.namePlaceholder")}
                  aria-invalid={Boolean(nameError)}
                  autoComplete="off"
                  onChange={(event) => {
                    setName(event.target.value);
                    if (nameError) {
                      setNameError(undefined);
                    }
                  }}
                />
                {nameError ? (
                  <FieldError errors={[{ message: nameError }]} />
                ) : null}
              </Field>
            </div>

            <Field>
              <FieldLabel htmlFor={`${formId}-description`}>
                {t("bots.fields.description")}
              </FieldLabel>
              <Input
                id={`${formId}-description`}
                value={description}
                placeholder={t("bots.fields.descriptionPlaceholder")}
                autoComplete="off"
                onChange={(event) => {
                  setDescription(event.target.value);
                }}
              />
            </Field>

            <Field>
              <FieldLabel htmlFor={`${formId}-project`}>
                {t("bots.fields.defaultProject")}
              </FieldLabel>
              <Select
                items={projectItems}
                value={defaultProjectId ?? NO_PROJECT_VALUE}
                onValueChange={(value) => {
                  setDefaultProjectId(
                    !value || value === NO_PROJECT_VALUE ? null : value
                  );
                }}
              >
                <SelectTrigger id={`${formId}-project`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_PROJECT_VALUE}>
                    {t("projects.none")}
                  </SelectItem>
                  {projects.map((project) => (
                    <SelectItem key={project.id} value={project.id}>
                      {project.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>

            <Field>
              <FieldLabel>{t("bots.fields.defaultModel")}</FieldLabel>
              <div className="flex items-center gap-2">
                <ModelSelect
                  models={models}
                  model={defaultModel}
                  modelEffort={defaultEffort}
                  onModelChange={setDefaultModel}
                  onModelEffortChange={setDefaultEffort}
                />
                {defaultModel ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t("bots.model.inheritGlobal")}
                    onClick={() => {
                      setDefaultModel(undefined);
                      setDefaultEffort(ModelEffort.Default);
                    }}
                  >
                    <XIcon />
                  </Button>
                ) : (
                  <span className="text-muted-foreground text-xs">
                    {t("bots.model.inheritGlobal")}
                  </span>
                )}
              </div>
            </Field>
          </FieldGroup>
        </form>

        {createMutation.isError ? (
          <p className="text-destructive text-sm" role="alert">
            {getErrorMessage(createMutation.error)}
          </p>
        ) : null}

        <DialogFooter>
          <DialogClose
            render={
              <Button
                type="button"
                variant="outline"
                disabled={createMutation.isPending}
              />
            }
          >
            {t("bots.actions.cancel")}
          </DialogClose>
          <Button
            type="submit"
            form={formId}
            loading={createMutation.isPending}
            disabled={createMutation.isPending}
          >
            {t("bots.createDialog.submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
