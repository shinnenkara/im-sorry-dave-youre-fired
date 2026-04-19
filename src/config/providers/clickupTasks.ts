import { z } from "zod";

export const clickupTasksProviderDefaults = {
  enabled: true,
} as const;

export const clickupTasksProviderSchema = z.object({
  enabled: z.boolean().default(clickupTasksProviderDefaults.enabled),
  type: z.literal("clickup-mcp"),
  server: z.string().min(1),
  user: z.string().min(1).optional(),
  debugOutputPath: z.string().min(1).optional(),
  enrichment: z
    .object({
      enabled: z.boolean().optional(),
      maxTasks: z.number().int().positive().max(500).optional(),
      concurrency: z.number().int().positive().max(50).optional(),
      maxCommentsPerTask: z.number().int().positive().max(50).optional(),
      scoring: z
        .object({
          keywordWeights: z.record(z.string(), z.number()).optional(),
          doneBoost: z.number().optional(),
          closedBoost: z.number().optional(),
          multiAssigneeBoost: z.number().optional(),
          nonBugBoost: z.number().optional(),
          recencyBoost: z.number().optional(),
          recencyWindowDays: z.number().int().positive().max(3650).optional(),
        })
        .optional(),
    })
    .optional(),
  tools: z.object({
    search: z.string().min(1),
  }),
});
