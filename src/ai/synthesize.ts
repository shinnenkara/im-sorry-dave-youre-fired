import { generateText } from "ai";

import type { ReviewConfig } from "../config/types.js";
import { resolveLanguageModel } from "./languageModel.js";

export interface SynthesisInput {
  config: ReviewConfig;
  modelId: string;
  evidenceContext: string;
  questionStrategyMarkdown?: string;
}

export function buildSynthesisSystemPrompt(): string {
  return [
    "You are an enterprise HR assistant writing performance reviews.",
    "Use only the supplied context.",
    "For aggregate claims, include at most 3-5 representative evidence IDs like [PR-1], [TASK-2], [COMM-3], never exhaustive lists.",
    "Do not produce long comma-separated citation walls.",
    "For specific incidents or concrete examples, cite focused evidence IDs for each claim.",
    "Treat user-provided notable projects as prioritization hints only; do not constrain the review to those items.",
    "If evidence is missing, explicitly state that data was unavailable.",
    "Maintain a professional, factual tone. Do not fabricate.",
  ].join(" ");
}

export function buildSynthesisUserPrompt(input: SynthesisInput): string {
  const notableProjects = input.config.notableProjects?.trim();
  const notableProjectsBlock =
    notableProjects && notableProjects.length > 0
      ? [
          "User-noted projects/workstreams to prioritize when evidence supports them:",
          notableProjects,
          "Important: include these if supported, but answer using the full evidence corpus and surface impactful work beyond this list.",
        ]
      : [];

  return [
    `Subject: ${input.config.subject.displayName}`,
    `Timeframe: ${input.config.timeframe.label}`,
    "Review questions:",
    input.config.reviewQuestions.map((question, index) => `${index + 1}. ${question}`).join("\n"),
    "",
    ...notableProjectsBlock,
    ...(notableProjectsBlock.length > 0 ? [""] : []),
    ...(input.questionStrategyMarkdown ? [input.questionStrategyMarkdown, ""] : []),
    "Evidence corpus:",
    input.evidenceContext,
    "",
    "Return markdown with sections per review question plus an executive summary.",
  ].join("\n");
}

export async function synthesizePerformanceReview(input: SynthesisInput): Promise<string> {
  const result = await generateText({
    model: resolveLanguageModel(input.modelId),
    maxRetries: 0,
    system: buildSynthesisSystemPrompt(),
    prompt: buildSynthesisUserPrompt(input),
  });

  return result.text.trim();
}
