import { initLogger } from "evlog";
import { createFsDrain } from "evlog/fs";

export const setupLogger = (dir: string) => {
  initLogger({ drain: createFsDrain({ dir, maxFiles: 7 }) });
};
