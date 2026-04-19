import { google } from "@ai-sdk/google";
import { generateText } from "ai";

import type { ReviewConfig } from "../config/types.js";

interface SynthesisInput {
  config: ReviewConfig;
  modelId: string;
  evidenceContext: string;
}

export async function synthesizePerformanceReview(input: SynthesisInput): Promise<string> {
  const result = await generateText({
    model: google(input.modelId),
    maxRetries: 0,
    system: [
      "You are an enterprise HR assistant writing performance reviews.",
      "Use only the supplied context.",
      "For every claim, cite specific evidence IDs like [PR-1], [TASK-2], [COMM-3].",
      "If evidence is missing, explicitly state that data was unavailable.",
      "Maintain a professional, factual tone. Do not fabricate.",
    ].join(" "),
    prompt: [
      `Subject: ${input.config.subject.displayName}`,
      `Timeframe: ${input.config.timeframe.label}`,
      "Review questions:",
      input.config.reviewQuestions.map((question, index) => `${index + 1}. ${question}`).join("\n"),
      "",
      "Evidence corpus:",
      input.evidenceContext,
      "",
      "Return markdown with sections per review question plus an executive summary.",
    ].join("\n"),
  });

  return result.text.trim();
}
