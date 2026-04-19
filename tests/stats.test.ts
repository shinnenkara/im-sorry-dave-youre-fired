import { describe, expect, test } from "vitest";

import { computeEvidenceStats, renderStatsMarkdown } from "../src/stats/compute.js";

describe("computeEvidenceStats", () => {
  test("computes deterministic numeric metrics from evidence", () => {
    const tasks = [
      {
        id: "task-1",
        source: "tasks" as const,
        title: "Critical bug in production import flow",
        summary: "Bug fixed for customer audit path with security implications",
        citation: "TASK-1",
      },
      {
        id: "task-2",
        source: "tasks" as const,
        title: "Feature: bulk assignment",
        summary: "Completed feature implementation",
        citation: "TASK-2",
      },
    ];
    const code = [
      {
        id: "code-1",
        source: "code" as const,
        title: "Fix null handling",
        summary: "Repository: acme/app Reviews: 2 total; APPROVED by Jane",
        citation: "PR-1",
      },
      {
        id: "code-2",
        source: "code" as const,
        title: "Reviewed data migration",
        summary: "Repository: acme/app Reviews: 3 total; APPROVED by Jane | COMMENTED by Jane",
        citation: "REVIEW-1",
      },
      {
        id: "code-3",
        source: "code" as const,
        title: "Reviewed API changes",
        summary: "Repository: acme/api Reviews: 1 total; COMMENTED by Jane",
        citation: "REVIEW-2",
      },
    ];

    const stats = computeEvidenceStats({ tasks, comms: [], code });
    expect(stats.totals.tasksCompleted).toBe(2);
    expect(stats.totals.mergedPrs).toBe(1);
    expect(stats.totals.reviewedPrs).toBe(2);
    expect(stats.totals.uniqueReposTouched).toBe(2);
    expect(stats.quality.bugLikeTasksResolved).toBe(1);
    expect(stats.quality.highValueBugTasksResolved).toBe(1);
    expect(stats.quality.bugFixPrsMerged).toBe(1);
    expect(stats.quality.securityRelatedChanges).toBe(1);
    expect(stats.collaboration.reviewEvents).toBe(4);
    expect(stats.collaboration.approvalsGiven).toBe(1);
  });
});

describe("renderStatsMarkdown", () => {
  test("renders numbers-only stats sections", () => {
    const markdown = renderStatsMarkdown(
      {
        timeframe: {
          label: "Jan 01, 2026 - Mar 31, 2026",
          slug: "q1-2026",
          providerScope: "2026-01-01 to 2026-03-31",
        },
        subject: { displayName: "Jane Doe" },
        reviewQuestions: ["q1"],
        outDir: "out",
        maxContextChars: 12000,
        models: { fast: "gpt-4o-mini", pro: "gpt-4o" },
        mcpServers: {},
        providers: { code: { enabled: true, type: "github-cli", prLimit: 10 } },
      },
      {
        totals: {
          tasksCompleted: 5,
          mergedPrs: 4,
          reviewedPrs: 7,
          uniqueReposTouched: 3,
          totalEvidenceItems: 16,
        },
        quality: {
          bugLikeTasksResolved: 2,
          highValueBugTasksResolved: 1,
          bugFixPrsMerged: 2,
          securityRelatedChanges: 1,
        },
        collaboration: {
          reviewEvents: 12,
          approvalsGiven: 6,
        },
      },
    );

    expect(markdown).toContain("# Performance Statistics — Jane Doe");
    expect(markdown).toContain("- Tasks completed: 5");
    expect(markdown).toContain("- Pull requests reviewed: 7");
    expect(markdown).toContain("- Review events recorded: 12");
  });
});
