import { z } from "zod";

export const slackCommsProviderDefaults = {
  enabled: true,
} as const;

export const slackCommsProviderSchema = z.object({
  enabled: z.boolean().default(slackCommsProviderDefaults.enabled),
  type: z.literal("slack-mcp"),
  server: z.string().min(1),
  debugOutputPath: z.string().min(1).optional(),
  expectedWorkspace: z.string().min(1).optional(),
  expectedUserId: z.string().min(1).optional(),
  expectedUserEmail: z.string().email().optional(),
  priorityChannels: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).optional(),
  reactions: z
    .object({
      enabled: z.boolean().optional(),
      maxMessages: z.number().int().positive().max(250).optional(),
    })
    .optional(),
  tools: z.object({
    search: z.string().min(1),
  }),
});
