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
  tools: z.object({
    search: z.string().min(1),
  }),
});
