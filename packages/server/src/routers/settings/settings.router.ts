import { hasOneKeySource } from "@workspace/shared/provider-key";
import z from "zod";

import { ApiError, ErrorMap } from "../../errors";
import { publicProcedure } from "../../index";
import { fetchModelList, ModelListError } from "./model-list";
import { providerKeyEnvSchema } from "./provider-key";
import {
  getUserSettingsRoute,
  updateUserSettingsRoute,
} from "./settings.service";

/**
 * 读供应商的模型列表。
 *
 * 入参是表单里的草稿，不是已保存的供应商：用户要先看到列表才决定存什么。
 *
 * The key takes the same two shapes as a provider row, and the row's rule applies here
 * too: one source, inside the namespace.
 */
const listModels = publicProcedure
  .errors({ MODEL_LIST_FAILED: ErrorMap.MODEL_LIST_FAILED })
  .input(
    z
      .object({
        baseURL: z.string(),
        apiKey: z.string().optional(),
        apiKeyEnv: providerKeyEnvSchema.optional(),
        headers: z.record(z.string(), z.string()).optional(),
      })
      .refine(
        (input) => hasOneKeySource({ ...input, apiKey: input.apiKey ?? "" }),
        {
          message: "give either apiKey or apiKeyEnv, not both",
          path: ["apiKeyEnv"],
        }
      )
  )
  .handler(async ({ input }) => {
    try {
      return { models: await fetchModelList(input) };
    } catch (error) {
      if (error instanceof ModelListError) {
        // The reason goes into the message as well as the payload: the screen shows
        // the message, and "could not be read" alone tells nobody what to fix.
        throw new ApiError("MODEL_LIST_FAILED", {
          message: `The provider's model list could not be read: ${error.reason}.`,
          data: { reason: error.reason },
        });
      }
      throw error;
    }
  });

export const setting = {
  get: getUserSettingsRoute,
  update: updateUserSettingsRoute,
  listModels,
};
