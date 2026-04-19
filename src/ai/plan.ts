import { google } from "@ai-sdk/google";
import { generateObject } from "ai";
import { z } from "zod";

import type { ReviewConfig } from "../config/types.js";

const queryPlanSchema = z.object({
  providerQueries: z.object({
    tasks: z.array(z.string()).default([]),
    comms: z.array(z.string()).default([]),
    code: z.array(z.string()).default([]),
  }),
  rationale: z.string().optional(),
});

export type QueryPlan = z.infer<typeof queryPlanSchema>;

export async function generateReviewQueryPlan(config: ReviewConfig, modelId: string): Promise<QueryPlan> {
  const { object } = await generateObject({
    model: google(modelId),
    maxRetries: 0,
    schema: queryPlanSchema,
    prompt: [
      "You are a planning assistant for enterprise performance review data collection.",
      "Generate concise search queries for three providers: tasks, comms, code.",
      "Only include query text that is useful to collect objective evidence.",
      `Timeframe: ${config.timeframe.label}`,
      `Subject: ${config.subject.displayName}`,
      `Questions:\n${config.reviewQuestions.map((item, index) => `${index + 1}. ${item}`).join("\n")}`,
    ].join("\n"),
  });

  return object;
}
