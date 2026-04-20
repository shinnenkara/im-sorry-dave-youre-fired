import { z } from "zod";

export const githubCodeProviderDefaults = {
  enabled: true,
  prLimit: 500,
} as const;

export const githubCodeProviderSchema = z.object({
  enabled: z.boolean().default(githubCodeProviderDefaults.enabled),
  type: z.literal("github-cli"),
  org: z.string().trim().min(1).optional(),
  repo: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).optional(),
  debugOutputPath: z.string().min(1).optional(),
  prLimit: z.number().int().positive().max(1000).default(githubCodeProviderDefaults.prLimit),
});
