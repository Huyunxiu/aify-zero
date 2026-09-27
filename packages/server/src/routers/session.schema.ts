import z from "zod";

export const listSessionTurnsSchema = z.object({
  sessionId: z.string(),
});

export const forkSessionSchema = z.object({
  sessionId: z.string(),
  messageId: z.string().optional(),
});

export type ForkSessionType = z.infer<typeof forkSessionSchema>;
