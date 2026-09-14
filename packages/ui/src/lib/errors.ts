import { parseError } from "@workspace/shared/errors";
import type { TFunction } from "i18next";

const ERROR_I18N_PREFIX = "errors";

/**
 * Resolution order: the localized message for the code, then the message the
 * server sent (so a code that has no translation yet still explains itself),
 * then the generic fallback.
 */
export function getErrorMessage(error: unknown, t: TFunction): string {
  const { code, message, data } = parseError(error);

  const translated = t(`${ERROR_I18N_PREFIX}.${code}`, {
    ...(isPlainObject(data) ? data : {}),
    defaultValue: "",
  });
  if (translated) {
    return translated;
  }

  return message || t(`${ERROR_I18N_PREFIX}.default`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
