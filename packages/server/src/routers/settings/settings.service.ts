import { publicProcedure } from "../../index";
import {
  createDict,
  findDictByCode,
  updateDict,
} from "../dict/dict.repository";
import {
  updateUserSettingsSchema,
  userSettingsSchema,
} from "./settings.schema";
import type { AiModel, UserSettings } from "./settings.schema";

const USER_SETTINGS_CODE = "user.settings";
const USER_SETTINGS_NAME = "User Settings";

/** Ensure the user.settings dict entry exists, creating it with defaults if not. */
async function ensureUserSettings(): Promise<UserSettings> {
  const existing = await findDictByCode(USER_SETTINGS_CODE);
  if (existing) {
    return existing.content as UserSettings;
  }

  const defaults = userSettingsSchema.parse({});
  await createDict({
    code: USER_SETTINGS_CODE,
    name: USER_SETTINGS_NAME,
    content: defaults,
  });
  return defaults;
}

/** Persist updated settings back to the dict store. */
async function saveUserSettings(settings: UserSettings): Promise<UserSettings> {
  const parsed = userSettingsSchema.parse(settings);
  await updateDict(USER_SETTINGS_CODE, { content: parsed });
  return parsed;
}

// ── User Settings routes ─────────────────────────────────────────────────────

export const getUserSettingsRoute = publicProcedure.handler(
  async () => await ensureUserSettings()
);

export const updateUserSettingsRoute = publicProcedure
  .input(updateUserSettingsSchema)
  .handler(async ({ input }) => {
    const current = await ensureUserSettings();
    const merged = { ...current, ...input };
    return await saveUserSettings(merged);
  });

/** Look up an AI model by id from the UserSettings store. */
export async function findAiModelById(
  id: string
): Promise<AiModel | undefined> {
  const settings = await ensureUserSettings();
  return settings.models.find((m) => m.id === id);
}
