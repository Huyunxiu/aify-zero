import type { ModelEffort } from "@workspace/shared/constants";
import type { ModelRef } from "@workspace/shared/model";

export type AgentStateOptions = {
  model: ModelRef;
  modelEffort?: ModelEffort;
};

export class AgentState {
  model: ModelRef;
  modelEffort?: ModelEffort;
  constructor(options: AgentStateOptions) {
    this.model = options.model;
    this.modelEffort = options.modelEffort;
  }
}
