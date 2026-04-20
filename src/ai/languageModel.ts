import { anthropic } from "@ai-sdk/anthropic";
import { google } from "@ai-sdk/google";

export function resolveLanguageModel(modelId: string) {
  const normalized = modelId.trim().toLowerCase();
  if (normalized.startsWith("gemini")) {
    return google(modelId);
  }
  if (normalized.startsWith("claude")) {
    return anthropic(modelId);
  }
  throw new Error(
    `Unsupported model "${modelId}". Use a model ID starting with "gemini" or "claude".`,
  );
}
