import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";

import { parse as parseYaml } from "yaml";
import { z } from "zod";

import { DEFAULT_REVIEW_CONFIG, getDefaultReviewConfig } from "./defaults.js";
import { providersSchema } from "./providers/registry.js";
import { resolveTimeframeInput } from "./timeframe.js";
import type { ReviewConfig, TimeframeYaml } from "./types.js";

const mcpServerSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  cwd: z.string().optional(),
});

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const timeframeYamlSchema: z.ZodType<TimeframeYaml> = z.union([
  z.string().min(1),
  z.discriminatedUnion("preset", [
    z.object({
      preset: z.enum(["last_3_months", "last_6_months", "last_12_months"]),
    }),
    z.object({
      preset: z.literal("custom"),
      start: isoDate,
      end: isoDate,
    }),
  ]),
]);

type ParsedReviewConfig = Omit<ReviewConfig, "timeframe"> & {
  timeframe: TimeframeYaml;
};

const reviewSchema: z.ZodType<ParsedReviewConfig> = z.object({
  appName: z.string().optional(),
  timeframe: timeframeYamlSchema,
  subject: z.object({
    displayName: z.string().min(1),
    email: z.string().email().optional(),
    slackUserId: z.string().regex(/^[UW][A-Z0-9]{6,}$/i).optional(),
    githubUsername: z.string().optional(),
  }),
  notableProjects: z.string().optional(),
  reviewQuestions: z.array(z.string().min(1)).min(1),
  outDir: z.string().min(1).default(DEFAULT_REVIEW_CONFIG.outDir),
  maxContextChars: z.number().int().positive().default(DEFAULT_REVIEW_CONFIG.maxContextChars),
  models: z
    .object({
      fast: z.string().min(1).default(DEFAULT_REVIEW_CONFIG.models.fast),
      pro: z.string().min(1).default(DEFAULT_REVIEW_CONFIG.models.pro),
    })
    .default(DEFAULT_REVIEW_CONFIG.models),
  mcpServers: z.record(z.string(), mcpServerSchema).default({}),
  providers: providersSchema,
});

export type ReviewConfigSchema = z.infer<typeof reviewSchema>;
export { DEFAULT_REVIEW_CONFIG, getDefaultReviewConfig };

export interface LoadReviewConfigOptions {
  /** Fix the “today” used when resolving rolling presets (tests and reproducible runs). */
  referenceDate?: Date;
  /** Interpolate ${ENV_VAR} placeholders in string values before validation. */
  interpolateEnv?: boolean;
}

function parseByExtension(filePath: string, raw: string): unknown {
  const extension = extname(filePath).toLowerCase();
  if (extension === ".yaml" || extension === ".yml") {
    return parseYaml(raw);
  }

  return JSON.parse(raw);
}

function resolveEnvPlaceholders(value: string): string {
  return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_match, variableName: string) => {
    const resolved = process.env[variableName];
    if (typeof resolved !== "string" || resolved.length === 0) {
      throw new Error(`Missing environment variable "${variableName}" referenced in config`);
    }
    return resolved;
  });
}

function interpolateEnvVars(value: unknown): unknown {
  if (typeof value === "string") {
    return resolveEnvPlaceholders(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => interpolateEnvVars(item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, interpolateEnvVars(nested)]),
    );
  }
  return value;
}

export async function loadReviewConfig(
  configPath: string,
  options?: LoadReviewConfigOptions,
): Promise<ReviewConfig> {
  const resolvedPath = resolve(configPath);
  const raw = await readFile(resolvedPath, "utf8");
  const parsedUnknown = parseByExtension(resolvedPath, raw);
  return parseReviewConfigFromUnknown(parsedUnknown, options);
}

export function parseReviewConfigFromUnknown(
  input: unknown,
  options?: LoadReviewConfigOptions,
): ReviewConfig {
  const shouldInterpolateEnv = options?.interpolateEnv ?? true;
  const candidate = shouldInterpolateEnv ? interpolateEnvVars(input) : input;
  const parsed = reviewSchema.parse(candidate);
  const notableProjects = parsed.notableProjects?.trim();
  return {
    ...parsed,
    notableProjects: notableProjects && notableProjects.length > 0 ? notableProjects : undefined,
    timeframe: resolveTimeframeInput(parsed.timeframe, options?.referenceDate ?? new Date()),
  };
}
