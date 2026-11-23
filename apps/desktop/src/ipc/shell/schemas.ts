import z from "zod";

export const openExternalLinkInputSchema = z.object({
  url: z.url(),
});

export const openPathInputSchema = z.object({
  path: z.string().min(1),
});
