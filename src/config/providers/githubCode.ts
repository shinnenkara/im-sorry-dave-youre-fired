import { z } from "zod";

export const githubCodeProviderDefaults = {
  enabled: true,
  prLimit: 100,
} as const;

export const githubCodeProviderSchema = z.object({
  enabled: z.boolean().default(githubCodeProviderDefaults.enabled),
  type: z.literal("github-cli"),
  repo: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).optional(),
  debugOutputPath: z.string().min(1).optional(),
  prLimit: z.number().int().positive().max(500).default(githubCodeProviderDefaults.prLimit),
});
