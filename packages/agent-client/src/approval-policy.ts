/**
 * The ask posture of one session.
 *
 * The client selects it, the server stores it, the agent reads it: three parties
 * share the values, so they live in the protocol package. It answers only "do we ask"; the Sandbox decides what is possible.
 */
export type ApprovalPolicy = "cautious" | "edit" | "readonly" | "unrestricted";

/** Use it when nobody selected a value. A session starts looser than a change, and asks for nothing else: the user removes the question on purpose. */
export const DEFAULT_APPROVAL_POLICY: ApprovalChoice = "edit";

/** From the strictest to the loosest. The UI lists them in this order, with the safest class on top. */
export const APPROVAL_POLICIES = [
  "readonly",
  "edit",
  "unrestricted",
] as const satisfies readonly ApprovalPolicy[];

/** One value the picker offers, and the only kind the API accepts for a session. */
export type ApprovalChoice = (typeof APPROVAL_POLICIES)[number];

/**
 * The posture an Unattended Run uses, and the one a sub session inherits from it.
 *
 * It asks before a change and stays silent for a command, so a Timer still runs the
 * project's own scripts. Nobody picks it, so it stays out of `APPROVAL_POLICIES` and out
 * of the picker; `effectivePolicy` supplies it.
 */
export const UNATTENDED_APPROVAL_POLICY: ApprovalPolicy = "cautious";
