import { ORPCError } from "@orpc/server";

import { publicProcedure } from "../../index";
import {
  findAiModelById,
  createAiModel,
  listAiModels,
  updateAiModel,
  deleteAiModel,
} from "./ai-model.repository";
import {
  createAiModelSchema,
  getAiModelSchema,
  updateAiModelSchema,
} from "./ai-model.schema";

export const createAiModelRoute = publicProcedure
  .route({ method: "POST", path: "/ai-models" })
  .input(createAiModelSchema)
  .handler(async ({ input }) => {
    const existing = await findAiModelById(input.id);
    if (existing) {
      throw new ORPCError("CONFLICT", {
        message: `AI model with id "${input.id}" already exists.`,
      });
    }
    return await createAiModel(input);
  });

export const listAiModelsRoute = publicProcedure
  .route({ method: "GET", path: "/ai-models" })
  .handler(async () => await listAiModels());

export const getAiModelRoute = publicProcedure
  .route({ method: "GET", path: "/ai-models/{id}" })
  .input(getAiModelSchema)
  .handler(async ({ input }) => {
    const { id } = input;
    const model = await findAiModelById(id);
    if (!model) {
      throw new ORPCError("NOT_FOUND", {
        message: `AI model "${id}" not found.`,
      });
    }
    return model;
  });

export const updateAiModelRoute = publicProcedure
  .route({ method: "PUT", path: "/ai-models/{id}" })
  .input(updateAiModelSchema)
  .handler(async ({ input }) => {
    const { id, ...data } = input;
    const model = await findAiModelById(id);
    if (!model) {
      throw new ORPCError("NOT_FOUND", {
        message: `AI model "${id}" not found.`,
      });
    }
    return await updateAiModel(id, data);
  });

export const removeAiModelRoute = publicProcedure
  .route({ method: "DELETE", path: "/ai-models/{id}" })
  .input(getAiModelSchema)
  .handler(async ({ input }) => {
    const { id } = input;
    const model = await findAiModelById(id);
    if (!model) {
      throw new ORPCError("NOT_FOUND", {
        message: `AI model "${id}" not found.`,
      });
    }
    return await deleteAiModel(id);
  });
