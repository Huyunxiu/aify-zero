import type { ModelEffort } from "@workspace/shared/constants";

export type AgentStateOptions = {
  modelId: string;
  modelEffort?: ModelEffort;
};

export class AgentState {
  modelId: string;
  modelEffort?: ModelEffort;
  constructor(options: AgentStateOptions) {
    this.modelId = options.modelId;
    this.modelEffort = options.modelEffort;
  }
}
