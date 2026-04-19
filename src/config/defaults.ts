import type { ReviewModelConfig } from "./types.js";

export const DEFAULT_REVIEW_MODELS: ReviewModelConfig = {
  fast: "gemini-2.5-flash",
  pro: "gemini-2.5-pro",
};

export const DEFAULT_REVIEW_CONFIG = {
  outDir: "out",
  maxContextChars: 120_000,
  models: DEFAULT_REVIEW_MODELS,
} as const;

export function getDefaultReviewConfig(): typeof DEFAULT_REVIEW_CONFIG {
  return {
    outDir: DEFAULT_REVIEW_CONFIG.outDir,
    maxContextChars: DEFAULT_REVIEW_CONFIG.maxContextChars,
    models: {
      fast: DEFAULT_REVIEW_CONFIG.models.fast,
      pro: DEFAULT_REVIEW_CONFIG.models.pro,
    },
  };
}
