import { Fragment, useMemo } from "react";

import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTransparentTrigger,
} from "../components/select";
import { ModelLogo } from "./model-logo";
import { PromptInputButton } from "./prompt-input";

export interface AiModelItem {
  id: string;
  name: string;
  provider: string;
}

export type ModelSelectProps = {
  models: AiModelItem[];
  value: string | undefined;
  onValueChange: (value: string) => void;
};

export function ModelSelect({
  models,
  value,
  onValueChange,
}: ModelSelectProps) {
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

  const allItems = useMemo(
    () => models.map((m) => ({ label: m.name, value: m.id })),
    [models]
  );

  const selectedModel = useMemo(
    () => models.find((m) => m.id === value),
    [models, value]
  );

  const providerEntries = useMemo(
    () => [...groupedModels.entries()],
    [groupedModels]
  );

  return (
    <Select
      items={allItems}
      value={value}
      onValueChange={(val) => {
        if (val) {
          onValueChange(val);
        }
      }}
    >
      <SelectTransparentTrigger
        className="w-full max-w-48"
        render={<PromptInputButton />}
      >
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
        </PromptInputButton>
      </SelectTransparentTrigger>
      <SelectContent className="min-w-fit">
        {providerEntries.map(([provider, providerModels], index) => (
          <Fragment key={provider}>
            <SelectGroup>
              <SelectLabel>{provider}</SelectLabel>
              {providerModels.map((model) => (
                <SelectItem key={model.id} value={model.id}>
                  <ModelLogo model={model.name} />
                  <span>{model.name}</span>
                </SelectItem>
              ))}
            </SelectGroup>
            {index < providerEntries.length - 1 && <SelectSeparator />}
          </Fragment>
        ))}
      </SelectContent>
    </Select>
  );
}
