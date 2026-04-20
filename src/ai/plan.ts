import { generateObject } from "ai";
import { z } from "zod";

import type { ReviewConfig } from "../config/types.js";
import { resolveLanguageModel } from "./languageModel.js";

const evidenceStrategySchema = z.enum(["aggregate", "mixed", "narrative"]);

const queryPlanSchema = z.object({
  providerQueries: z.object({
    tasks: z.array(z.string()).default([]),
    comms: z.array(z.string()).default([]),
    code: z.array(z.string()).default([]),
  }),
  questionStrategies: z
    .array(
      z.object({
        questionIndex: z.number().int().min(1),
        evidenceStrategy: evidenceStrategySchema,
      }),
    )
    .default([]),
  rationale: z.string().optional(),
});

export type QueryPlan = z.infer<typeof queryPlanSchema>;

export async function generateReviewQueryPlan(config: ReviewConfig, modelId: string): Promise<QueryPlan> {
  const notableProjectsSection =
    config.notableProjects && config.notableProjects.length > 0
      ? [
          "User-provided notable projects/workstreams hint (may be incomplete):",
          config.notableProjects,
          "Prioritize these topics when creating targeted queries, but do not limit the search scope to this hint.",
          "Always include broad discovery queries that can surface additional impactful work beyond the hint list.",
        ].join("\n")
      : undefined;

  const { object } = await generateObject({
    model: resolveLanguageModel(modelId),
    maxRetries: 0,
    schema: queryPlanSchema,
    prompt: [
      "You are a planning assistant for enterprise performance review data collection.",
      "Generate concise search queries for three providers: tasks, comms, code.",
      "Only include query text that is useful to collect objective evidence.",
      "Balance broad discovery with focused lookups: include at least one broad query per provider whenever possible.",
      "For each review question, classify the answer strategy as aggregate, mixed, or narrative.",
      "Use aggregate for broad throughput/consistency questions, narrative for specific examples, mixed for hybrid questions.",
      `Timeframe: ${config.timeframe.label}`,
      `Subject: ${config.subject.displayName}`,
      ...(notableProjectsSection ? [notableProjectsSection] : []),
      `Questions:\n${config.reviewQuestions.map((item, index) => `${index + 1}. ${item}`).join("\n")}`,
    ].join("\n"),
  });

  return object;
}
