import z from "zod";

import { ApiError, ErrorMap } from "../../errors";
import { publicProcedure } from "../../index";
import { fetchModelList, ModelListError } from "./model-list";
import {
  getUserSettingsRoute,
  updateUserSettingsRoute,
} from "./settings.service";

/**
 * 读供应商的模型列表。
 *
 * 入参是表单里的草稿，不是已保存的供应商：用户要先看到列表才决定存什么。
 */
const listModels = publicProcedure
  .errors({ MODEL_LIST_FAILED: ErrorMap.MODEL_LIST_FAILED })
  .input(
    z.object({
      baseURL: z.string(),
      apiKey: z.string(),
      headers: z.record(z.string(), z.string()).optional(),
    })
  )
  .handler(async ({ input }) => {
    try {
      return { models: await fetchModelList(input) };
    } catch (error) {
      if (error instanceof ModelListError) {
        throw new ApiError("MODEL_LIST_FAILED", {
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
