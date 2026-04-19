import { describe, expect, test } from "vitest";

import { normalizeTextChunks, renderEvidenceForPrompt } from "../src/normalize/evidence.js";

describe("normalizeTextChunks", () => {
  test("creates citations and summaries", () => {
    const items = normalizeTextChunks("code", ["PR one\nLine two"], "PR");
    expect(items).toHaveLength(1);
    expect(items[0]?.citation).toBe("PR-1");
    expect(items[0]?.summary).toContain("PR one");
  });
});

describe("renderEvidenceForPrompt", () => {
  test("renders structured output", () => {
    const items = normalizeTextChunks("tasks", ["Task A"], "TASK");
    const rendered = renderEvidenceForPrompt(items);
    expect(rendered).toContain("Citation: TASK-1");
    expect(rendered).toContain("Summary: Task A");
  });
});
