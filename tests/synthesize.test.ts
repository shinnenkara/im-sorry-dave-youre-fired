import { describe, expect, test } from "vitest";

import { buildSynthesisSystemPrompt, buildSynthesisUserPrompt } from "../src/ai/synthesize.js";

describe("buildSynthesisSystemPrompt", () => {
  test("enforces concise aggregate citations and bans citation walls", () => {
    const prompt = buildSynthesisSystemPrompt();

    expect(prompt).toContain("include at most 3-5 representative evidence IDs");
    expect(prompt).toContain("Do not produce long comma-separated citation walls");
    expect(prompt).toContain("notable projects as prioritization hints only");
  });
});

describe("buildSynthesisUserPrompt", () => {
  test("includes strategy hints, notable projects, and evidence corpus sections", () => {
    const prompt = buildSynthesisUserPrompt({
      config: {
        timeframe: {
          label: "Jan 01, 2026 - Mar 31, 2026",
          slug: "q1-2026",
          providerScope: "2026-01-01 to 2026-03-31",
        },
        subject: { displayName: "Jane Doe" },
        notableProjects: "Apollo migration\nIncident response",
        reviewQuestions: ["What did Jane deliver?"],
        outDir: "out",
        maxContextChars: 12000,
        models: { fast: "gemini-2.5-flash", pro: "gemini-2.5-pro" },
        mcpServers: {},
        providers: { code: { enabled: true, type: "github-cli", prLimit: 10 } },
      },
      modelId: "gemini-2.5-pro",
      questionStrategyMarkdown: "## Planner strategy hints\n\n- Q1: aggregate — What did Jane deliver?",
      evidenceContext: "Citation: TASK-1\nTitle: Feature delivery\nSummary: Delivered feature",
    });

    expect(prompt).toContain("Subject: Jane Doe");
    expect(prompt).toContain("## Planner strategy hints");
    expect(prompt).toContain("User-noted projects/workstreams to prioritize");
    expect(prompt).toContain("Apollo migration");
    expect(prompt).toContain("full evidence corpus");
    expect(prompt).toContain("Evidence corpus:");
    expect(prompt).toContain("Citation: TASK-1");
  });
});
