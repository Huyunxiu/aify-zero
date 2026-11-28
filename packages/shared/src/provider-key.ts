/**
 * Where a provider's key comes from.
 *
 * A provider row holds either the key itself or the name of an environment variable. The
 * name is limited to one namespace: the settings and the provider URL are both written by
 * whoever calls the API, and without a namespace that caller could name any variable in
 * the process and have its value sent to a server of their own.
 */

/** The namespace a key reference must sit in. */
export const PROVIDER_KEY_ENV_PREFIX = "AIFY_PROVIDER_KEY_";

const PROVIDER_KEY_ENV_PATTERN = new RegExp(
  `^${PROVIDER_KEY_ENV_PREFIX}[A-Za-z0-9_]+$`,
  "u"
);

/** Whether `name` can be used as a key reference. */
export function isProviderKeyEnvName(name: string): boolean {
  return PROVIDER_KEY_ENV_PATTERN.test(name);
}

/** The two ways a provider row can say where its key is. */
export interface ProviderKeySources {
  /** The key itself; empty when the row names a variable instead. */
  readonly apiKey: string;
  /** The name of an environment variable holding the key. */
  readonly apiKeyEnv?: string;
}

/**
 * Whether the row names one source and not two.
 *
 * A row with both is rejected rather than resolved: two sources on one line leave the
 * reader unable to tell which one the next call uses.
 */
export function hasOneKeySource(sources: ProviderKeySources): boolean {
  return sources.apiKeyEnv === undefined || sources.apiKey.trim().length === 0;
}

/**
 * The reference to save, given what is on the row right now.
 *
 * A typed key wins. The row must never carry both, and a key someone just typed is the
 * more recent intent; the variable name is also the one thing that can be reproduced.
 */
export function providerKeyReference(
  sources: ProviderKeySources
): string | undefined {
  return sources.apiKey.trim().length === 0 ? sources.apiKeyEnv : undefined;
}
