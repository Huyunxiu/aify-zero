import { os } from "@orpc/server";
import { shell } from "electron";

import { openExternalLinkInputSchema, openPathInputSchema } from "./schemas";

export const openExternalLink = os
  .input(openExternalLinkInputSchema)
  .handler(async ({ input }) => {
    const { url } = input;
    await shell.openExternal(url);
  });

export const openPath = os
  .input(openPathInputSchema)
  .handler(async ({ input }) => await shell.openPath(input.path));
