import { MODEL_EFFORT_LABELS, ModelEffort } from "@workspace/shared/constants";
import { ChevronLeftIcon, XIcon } from "lucide-react";
import { Fragment, useMemo, useState } from "react";
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
import { ModelLogo } from "./model-logo";
import { PromptInputButton } from "./prompt-input";

export interface AiModelItem {
  id: string;
  name: string;
  provider: string;
}

export type ModelSelectProps = {
  models: AiModelItem[];
  modelId: string | undefined;
  modelEffort: ModelEffort | undefined;
  onModelChange: (modelId: string) => void;
  onModelEffortChange: (effort: ModelEffort) => void;
};

export function ModelSelect({
  models,
  modelId,
  modelEffort = ModelEffort.Default,
  onModelChange,
  onModelEffortChange,
}: ModelSelectProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [effortClose, setEffortClose] = useState(false);
  const [effort, setEffor] = useState(modelEffort);

  const groupedModels = useMemo(() => {
    const groups = new Map<string, AiModelItem[]>();
    for (const model of models) {
      const group = groups.get(model.provider);
      if (group) {
        group.push(model);
      } else {
        groups.set(model.provider, [model]);
      }
    }
    return groups;
  }, [models]);

  const selectedModel = useMemo(
    () => models.find((m) => m.id === modelId),
    [models, modelId]
  );

  const providerEntries = useMemo(
    () => [...groupedModels.entries()],
    [groupedModels]
  );

  return (
    <Popover
      open={open}
      onOpenChange={(val) => {
        setOpen(val);
      }}
    >
      <PopoverTrigger className="w-fit" render={<PromptInputButton />}>
        <PromptInputButton>
          {selectedModel ? (
            <ModelLogo model={selectedModel.name} />
          ) : (
            <span>Select model</span>
          )}
          {selectedModel ? (
            <>
              <span>{selectedModel.name}</span>
            </>
          ) : null}
          {selectedModel ? (
            <>
              <span className="text-muted-foreground">
                {t(`modelEffort.values.${modelEffort}`)}
              </span>
            </>
          ) : null}
        </PromptInputButton>
      </PopoverTrigger>
      <PopoverContent align="center" className="p-0">
        {selectedModel && !effortClose ? (
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
          <Command className="p-0">
            <CommandList>
              <CommandEmpty>No results found.</CommandEmpty>
              {providerEntries.map(([provider, providerModels], index) => (
                <Fragment key={provider}>
                  <CommandGroup heading={provider}>
                    {providerModels.map((model) => (
                      <CommandItem
                        key={model.id}
                        value={model.id}
                        onSelect={(_modelId) => {
                          setEffortClose(false);
                          onModelChange(_modelId);
                        }}
                      >
                        <ModelLogo model={model.name} />
                        <span>{model.name}</span>
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
