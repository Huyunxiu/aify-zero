/**
 * Reading a provider's key at the moment a call is assembled.
 *
 * A provider row holds either the key or the name of an environment variable. The rule
 * that keeps it to one source, and the namespace a name must sit in, live in
 * `@workspace/shared/provider-key`; this module turns either shape into the string a
 * request carries.
 */
import {
  isProviderKeyEnvName,
  PROVIDER_KEY_ENV_PREFIX,
} from "@workspace/shared/provider-key";
import type { ProviderKeySources } from "@workspace/shared/provider-key";
import z from "zod";

import { ApiError } from "../../errors";

export { PROVIDER_KEY_ENV_PREFIX };

/**
 * A key reference: a name inside the namespace.
 *
 * Validating the shape when the row is saved makes a typo fail at that moment, instead of
 * at the first call, where it can only read as "the key is not readable".
 */
export const providerKeyEnvSchema = z.string().refine(isProviderKeyEnvName, {
  message: `must name an environment variable inside ${PROVIDER_KEY_ENV_PREFIX}`,
});

/**
 * What the environment holds for `name` right now.
 *
 * @param name - the variable name.
 * @returns the value with its ends trimmed; `undefined` when unset or only whitespace.
 */
function providerKeyEnvValue(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
}

/** The key a request carries, or the variable that turned out to be empty. */
export type ProviderKeyRead =
  | { readonly ok: true; readonly key: string }
  | { readonly ok: false; readonly env: string };

/**
 * Read the key a call should carry.
 *
 * The one place that decides where the key comes from. Two callers want different errors
 * for the same failure, so this reports the outcome and they raise their own.
 *
 * @param sources - the row's key fields.
 */
export function readProviderKey(sources: ProviderKeySources): ProviderKeyRead {
  const name = sources.apiKeyEnv;
  if (name === undefined) {
    return { ok: true, key: sources.apiKey };
  }
  const value = providerKeyEnvValue(name);
  return value === undefined
    ? { ok: false, env: name }
    : { ok: true, key: value };
}

/**
 * The key a request carries.
 *
 * The message names the variable, because that is the one thing a reader can act on; the
 * catalogs hold no interpolation, so the sentence is written here.
 *
 * @param sources - the row's key fields.
 * @throws ApiError `PROVIDER_KEY_MISSING` when the named variable is empty.
 */
export function providerKey(
  sources: ProviderKeySources & { readonly id: string }
): string {
  const read = readProviderKey(sources);
  if (!read.ok) {
    throw new ApiError("PROVIDER_KEY_MISSING", {
      message: `The provider key is not readable: environment variable ${read.env} is empty.`,
      data: { providerId: sources.id, env: read.env },
    });
  }
  return read.key;
}
