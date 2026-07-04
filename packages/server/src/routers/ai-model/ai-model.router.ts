import {
  createAiModelRoute,
  getAiModelRoute,
  listAiModelsRoute,
  removeAiModelRoute,
  updateAiModelRoute,
} from "./ai-model.service";

export const aiModel = {
  create: createAiModelRoute,
  list: listAiModelsRoute,
  get: getAiModelRoute,
  update: updateAiModelRoute,
  delete: removeAiModelRoute,
};
