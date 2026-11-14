import { publicProcedure } from "../../index";
import { dropStaleMcpCredentials } from "../../mcp/credentials-cleanup";
import { mcpAuthorizationFlows } from "../../mcp/oauth";
import { getMcpManager } from "../../mcp/registry";
import { assertUniqueMcpServers } from "../../mcp/validate";
import {
  createDict,
  findDictByCode,
  updateDict,
} from "../dict/dict.repository";
import { normalizeUserSettings } from "./settings.normalize";
import {
  updateUserSettingsSchema,
  USER_SETTINGS_DEFAULTS,
} from "./settings.schema";
import type {
  ConfiguredModel,
  ModelRef,
  UserSettings,
} from "./settings.schema";

const USER_SETTINGS_CODE = "user.settings";
const USER_SETTINGS_NAME = "User Settings";

/**
 * Ensure the user.settings dict entry exists, creating it with defaults if not.
 *
 * 存下来的内容一律过一遍 schema：新增字段的默认值只在这里补齐，读到的设置
 * 因此总是完整的一份，调用方不用到处写 `?? []`。
 */
async function ensureUserSettings(): Promise<UserSettings> {
  const existing = await findDictByCode(USER_SETTINGS_CODE);
  if (existing) {
    // 旧版本写下的设置缺字段，用默认值补齐、再按当前形状收敛，才交给调用方。
    return normalizeUserSettings(existing.content, USER_SETTINGS_DEFAULTS);
  }

  await createDict({
    code: USER_SETTINGS_CODE,
    name: USER_SETTINGS_NAME,
    content: USER_SETTINGS_DEFAULTS,
  });
  return USER_SETTINGS_DEFAULTS;
}

/** Persist updated settings back to the dict store. */
async function saveUserSettings(settings: UserSettings): Promise<UserSettings> {
  const parsed = normalizeUserSettings(settings, USER_SETTINGS_DEFAULTS);
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
    // 显式的 undefined 也算「没提交」，别用它覆盖已存的值。
    const patch = Object.fromEntries(
      Object.entries(input).filter(([, value]) => value !== undefined)
    );
    const merged = { ...current, ...patch };

    const touchedMcp = input.mcpServers !== undefined;
    if (touchedMcp) {
      // 只在提交了 MCP 配置时校验：旧数据里的冲突不该把别的设置项也锁住。
      assertUniqueMcpServers(merged.mcpServers);
    }

    const saved = await saveUserSettings(merged);

    if (touchedMcp) {
      // 地址或授权方式变了的服务器，旧令牌已经对不上新配置，先清掉。
      const dropped = await dropStaleMcpCredentials(
        current.mcpServers,
        saved.mcpServers
      );
      for (const id of dropped) {
        mcpAuthorizationFlows.forget(id);
      }

      // 只打标记：正在跑的回合还用着旧连接，下一次装配才重建。
      getMcpManager().invalidate();
    }

    return saved;
  });

/** The user's settings, created with defaults on first read. */
export async function getUserSettings(): Promise<UserSettings> {
  return await ensureUserSettings();
}

/** 按引用找出一个已配置的模型，连同它所属的供应商。 */
export async function findConfiguredModel(
  ref: ModelRef
): Promise<ConfiguredModel | undefined> {
  const settings = await ensureUserSettings();
  const provider = settings.providers.find(
    (entry) => entry.id === ref.providerId
  );
  const model = provider?.models.find((entry) => entry.id === ref.modelId);
  // 关掉的供应商或模型不能被调用：界面不显示它们，服务端也要拒绝。
  if (!provider?.active || !model?.active) {
    return undefined;
  }
  return { ref, provider, model };
}
