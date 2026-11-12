import { MODEL_EFFORT_LABELS, ModelEffort } from "@workspace/shared/constants";
import type { ModelRef } from "@workspace/shared/model";
import { ChevronLeftIcon, XIcon } from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { ComponentRef } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "../components/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "../components/command";
import { Popover, PopoverContent, PopoverTrigger } from "../components/popover";
import { Slider } from "../components/slider";
import { sameModel } from "../lib/models";
import type { ModelOption } from "../lib/models";
import { ModelLogo } from "./model-logo";
import { PromptInputButton } from "./prompt-input";

export type ModelSelectProps = {
  models: ModelOption[];
  model: ModelRef | undefined;
  modelEffort: ModelEffort | undefined;
  onModelChange: (model: ModelRef) => void;
  onModelEffortChange: (effort: ModelEffort) => void;
};

export function ModelSelect({
  models,
  model,
  modelEffort = ModelEffort.Default,
  onModelChange,
  onModelEffortChange,
}: ModelSelectProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [effortClose, setEffortClose] = useState(false);
  const [effort, setEffor] = useState(modelEffort);
  const commandRef = useRef<ComponentRef<typeof Command>>(null);

  // 选择器按供应商分组：同一家的模型排在一起。
  const providerEntries = useMemo(() => {
    const groups = new Map<string, ModelOption[]>();
    for (const option of models) {
      const group = groups.get(option.providerName);
      if (group) {
        group.push(option);
      } else {
        groups.set(option.providerName, [option]);
      }
    }
    return [...groups.entries()];
  }, [models]);

  const selectedModel = useMemo(
    () => models.find((option) => sameModel(option.ref, model)),
    [models, model]
  );

  // 不支持推理的模型没有档位可选，直接选完即关。
  const canPickEffort = selectedModel?.reasoning ?? false;

  // The popover's default focus lands on its container (cmdk's root is
  // tabIndex=-1, not tabbable), so cmdk's internal keydown handler would
  // never see arrow/enter keys. Focus the root whenever the list is shown.
  useEffect(() => {
    if (open && (!selectedModel || effortClose || !canPickEffort)) {
      commandRef.current?.focus();
    }
  }, [open, effortClose, selectedModel, canPickEffort]);

  return (
    <Popover
      open={open}
      onOpenChange={(val) => {
        setOpen(val);
        if (val) {
          setEffortClose(false);
          setEffor(modelEffort);
        }
      }}
    >
      <PopoverTrigger className="w-fit" render={<div />} nativeButton={false}>
        <PromptInputButton>
          {selectedModel ? (
            <ModelLogo model={selectedModel.name} />
          ) : (
            <span>{t("settings.provider.selectModel")}</span>
          )}
          {selectedModel ? <span>{selectedModel.name}</span> : null}
          {selectedModel && canPickEffort ? (
            <span className="text-muted-foreground">
              {t(`modelEffort.values.${modelEffort}`)}
            </span>
          ) : null}
        </PromptInputButton>
      </PopoverTrigger>
      <PopoverContent align="center" className="p-0">
        {selectedModel && !effortClose && canPickEffort ? (
          <div className="flex flex-col gap-2 p-2">
            <div className="flex justify-between">
              <div className="flex">
                <PromptInputButton
                  className="px-1"
                  onClick={() => setEffortClose(true)}
                >
                  <ChevronLeftIcon className="pointer-events-none size-4 text-muted-foreground" />
                  <ModelLogo model={selectedModel.name} />
                  <span>{selectedModel.name}</span>
                </PromptInputButton>
              </div>
              <div>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setOpen(false)}
                >
                  <XIcon />
                </Button>
              </div>
            </div>
            <Slider
              label={t("modelEffort.effort")}
              value={MODEL_EFFORT_LABELS.indexOf(effort) || 0}
              onChange={(v) => {
                if (typeof v === "number") {
                  setEffor(MODEL_EFFORT_LABELS[v] ?? ModelEffort.Default);
                }
              }}
              min={0}
              max={MODEL_EFFORT_LABELS.length - 1}
              formatValue={(v) =>
                t(
                  `modelEffort.values.${
                    MODEL_EFFORT_LABELS[v] ?? ModelEffort.Default
                  }`
                )
              }
            />
            <div>
              <Button
                className="w-full"
                variant="secondary"
                onClick={() => {
                  if (effort) {
                    onModelEffortChange(effort);
                    setOpen(false);
                  }
                }}
              >
                {t("modelEffort.apply")}
              </Button>
            </div>
          </div>
        ) : (
          <Command ref={commandRef} className="p-0">
            <CommandList>
              <CommandEmpty>{t("settings.provider.noModels")}</CommandEmpty>
              {providerEntries.map(([providerName, providerModels], index) => (
                <Fragment key={providerName}>
                  <CommandGroup heading={providerName}>
                    {providerModels.map((option) => (
                      <CommandItem
                        key={`${option.ref.providerId}/${option.ref.modelId}`}
                        value={`${option.ref.providerId}/${option.ref.modelId}`}
                        onSelect={() => {
                          setEffortClose(false);
                          setEffor(modelEffort);
                          onModelChange(option.ref);
                          if (!option.reasoning) {
                            setOpen(false);
                          }
                        }}
                      >
                        <ModelLogo model={option.name} />
                        <span>{option.name}</span>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                  {index < providerEntries.length - 1 && <CommandSeparator />}
                </Fragment>
              ))}
            </CommandList>
          </Command>
        )}
      </PopoverContent>
    </Popover>
  );
}
