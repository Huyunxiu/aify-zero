import {
  getUserSettingsRoute,
  updateUserSettingsRoute,
} from "./settings.service";

export const setting = {
  get: getUserSettingsRoute,
  update: updateUserSettingsRoute,
};
