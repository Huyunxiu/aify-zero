/**
 * The ask posture of one session.
 *
 * The client selects it, the server stores it, the agent reads it: three parties
 * share the values, so they live in the protocol package. It answers only "do we ask"; the Sandbox decides what is possible.
 */
export type ApprovalPolicy = "standard" | "edit" | "readonly" | "unrestricted";

/** Use it when nobody selected a value: same behavior as before the policy. The UI, the storage, and the decision all read this value. */
export const DEFAULT_APPROVAL_POLICY: ApprovalPolicy = "standard";

/** From the strictest to the loosest. The UI lists them in this order, with the safest class on top. */
export const APPROVAL_POLICIES = [
  "readonly",
  "standard",
  "edit",
  "unrestricted",
] as const satisfies readonly ApprovalPolicy[];
