import type { Language } from "@workspace/shared/constants";

import type { ErrorCode } from "../errors";
import enUSMessages from "./locales/en-US/common.json";
import enUSErrors from "./locales/en-US/errors.json";
import zhCNMessages from "./locales/zh-CN/common.json";
import zhCNErrors from "./locales/zh-CN/errors.json";

/**
 * The server's own copy. `en-US` is the reference: it defines the vocabulary,
 * and every other language has to carry the same keys — one missing is a
 * compile error rather than a message that quietly goes out untranslated.
 *
 * Deliberately not the UI's `packages/ui/src/i18n/locales/*`: those are strings
 * for a screen, these are messages an API hands back, and the two are free to
 * diverge. The error half (`errors.json`) is on purpose word-for-word the UI's
 * wording, so the same failure reads the same whichever surface shows it.
 */
const messages: Record<Language, typeof enUSMessages> = {
  "en-US": enUSMessages,
  "zh-CN": zhCNMessages,
};

/**
 * Error code to message. The `Record<ErrorCode, string>` is the point of this
 * table: add a code to `ErrorMap` without translating it here and the build
 * fails, so the API cannot answer with a message it has no language for.
 */
const errorMessages: Record<Language, Record<ErrorCode, string>> = {
  "en-US": enUSErrors,
  "zh-CN": zhCNErrors,
};

/** Every message a catalog has to carry, taken from the reference language. */
export type TranslationKey = keyof typeof enUSMessages;

/**
 * The message `key` reads as in `lang`. There is no runtime fallback: the key
 * is one the catalogs all declare and the language is one `Context.language`
 * guarantees, so the cases a fallback would catch cannot compile in the first
 * place.
 */
export function t(lang: Language, key: TranslationKey): string {
  return messages[lang][key];
}

/** What `code` reads as in `lang`. */
export function errorMessage(lang: Language, code: ErrorCode): string {
  return errorMessages[lang][code];
}
