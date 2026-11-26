/**
 * The two facts one model request depends on, read as one value.
 *
 * A model target holds them apart: `protocol` names the shape the provider accepts, and
 * `inputKinds` names the media the model reads. Request assembly needs both for the same
 * message array, so it reads them together; a rule that saw one and not the other would
 * answer half the question.
 *
 * @module
 */

import type { ModelProtocol } from "@workspace/shared/model";

import type { ModelTarget } from "../kernel/model-gateway";
import { TEXT_ONLY_INPUT_KINDS } from "./input-kinds";

/** One model route as request assembly needs it. */
export interface ModelRoute {
  /** The request format the provider accepts. */
  readonly protocol: ModelProtocol;
  /** The media kinds the model reads, as the settings schema spells them. */
  readonly inputKinds: readonly string[];
}

/**
 * The route to assume when the model does not resolve.
 *
 * A route that is not configured reaches neither an image nor a file in a tool result,
 * so the narrowest answer is also the safe one; the call itself fails later, when the
 * gateway cannot build a model for it.
 */
const NARROWEST_ROUTE: ModelRoute = {
  protocol: "openai-chat",
  inputKinds: TEXT_ONLY_INPUT_KINDS,
};

/**
 * Read the route from a model target.
 * @param target - the resolved target, or `undefined` when the model is not configured.
 * @returns the route, with text only for a model that declares no kinds.
 */
export function routeOf(
  target: Pick<ModelTarget, "protocol" | "inputKinds"> | undefined
): ModelRoute {
  if (target === undefined) {
    return NARROWEST_ROUTE;
  }
  return {
    protocol: target.protocol,
    inputKinds: target.inputKinds ?? TEXT_ONLY_INPUT_KINDS,
  };
}
