import type { ReviewConfig } from "../config/types.js";
import { DEFAULT_REVIEW_CONFIG } from "../config/defaults.js";

export const DEFAULT_FAST_MODEL = DEFAULT_REVIEW_CONFIG.models.fast;
export const DEFAULT_PRO_MODEL = DEFAULT_REVIEW_CONFIG.models.pro;

export interface ResolvedModels {
  fast: string;
  pro: string;
}

export function resolveModels(config: ReviewConfig): ResolvedModels {
  return {
    fast: config.models.fast,
    pro: config.models.pro,
  };
}
