import { beforeEach, describe, expect, test, vi } from "vitest";

const { anthropicMock, googleMock } = vi.hoisted(() => ({
  anthropicMock: vi.fn((modelId: string) => ({ provider: "anthropic", modelId })),
  googleMock: vi.fn((modelId: string) => ({ provider: "google", modelId })),
}));

vi.mock("@ai-sdk/anthropic", () => ({
  anthropic: anthropicMock,
}));

vi.mock("@ai-sdk/google", () => ({
  google: googleMock,
}));

import { resolveLanguageModel } from "../src/ai/languageModel.js";

describe("resolveLanguageModel", () => {
  beforeEach(() => {
    anthropicMock.mockClear();
    googleMock.mockClear();
  });

  test("routes gemini models to Google provider", () => {
    const model = resolveLanguageModel("gemini-2.5-flash");
    expect(model).toEqual({ provider: "google", modelId: "gemini-2.5-flash" });
    expect(googleMock).toHaveBeenCalledWith("gemini-2.5-flash");
    expect(anthropicMock).not.toHaveBeenCalled();
  });

  test("routes claude models to Anthropic provider", () => {
    const model = resolveLanguageModel("claude-sonnet-4-6");
    expect(model).toEqual({ provider: "anthropic", modelId: "claude-sonnet-4-6" });
    expect(anthropicMock).toHaveBeenCalledWith("claude-sonnet-4-6");
    expect(googleMock).not.toHaveBeenCalled();
  });

  test("throws a clear error for unsupported model prefixes", () => {
    expect(() => resolveLanguageModel("gpt-5.4")).toThrow(
      'Unsupported model "gpt-5.4". Use a model ID starting with "gemini" or "claude".',
    );
  });
});
