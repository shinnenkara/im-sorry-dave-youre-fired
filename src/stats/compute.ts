import type { ReviewConfig } from "../config/types.js";
import type { NormalizedEvidence } from "../providers/contracts.js";

const bugKeywords = [
  "bug",
  "fix",
  "regression",
  "incident",
  "hotfix",
  "defect",
  "failure",
  "error",
  "security",
  "cve",
];

const highImpactKeywords = [
  "critical",
  "urgent",
  "high",
  "p0",
  "p1",
  "sev1",
  "sev2",
  "production",
  "customer",
  "audit",
  "security",
  "cve",
];

const securityKeywords = ["security", "cve", "vulnerability", "auth bypass", "access control"];

function toSearchableText(item: NormalizedEvidence): string {
  return `${item.title} ${item.summary}`.toLowerCase();
}

function includesKeyword(text: string, keywords: readonly string[]): boolean {
  return keywords.some((keyword) => text.includes(keyword.toLowerCase()));
}

function extractReviewEvents(summary: string): number {
  const match = summary.match(/\bReviews:\s*(\d+)\s+total\b/i);
  if (!match?.[1]) {
    return 0;
  }
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function extractApprovals(summary: string): number {
  return [...summary.matchAll(/\bAPPROVED by\b/gi)].length;
}

function extractRepository(summary: string): string | undefined {
  const match = summary.match(/\bRepository:\s*([a-z0-9_.-]+\/[a-z0-9_.-]+)/i);
  return match?.[1];
}

export interface ComputedStats {
  totals: {
    tasksCompleted: number;
    mergedPrs: number;
    reviewedPrs: number;
    totalEvidenceItems: number;
    uniqueReposTouched: number;
  };
  quality: {
    bugLikeTasksResolved: number;
    highValueBugTasksResolved: number;
    bugFixPrsMerged: number;
    securityRelatedChanges: number;
  };
  collaboration: {
    reviewEvents: number;
    approvalsGiven: number;
  };
}

export function computeEvidenceStats(input: {
  tasks: readonly NormalizedEvidence[];
  comms: readonly NormalizedEvidence[];
  code: readonly NormalizedEvidence[];
}): ComputedStats {
  const mergedPrs = input.code.filter((item) => item.citation.startsWith("PR-"));
  const reviewedPrs = input.code.filter((item) => item.citation.startsWith("REVIEW-"));

  const bugLikeTasksResolved = input.tasks.filter((item) => includesKeyword(toSearchableText(item), bugKeywords)).length;
  const highValueBugTasksResolved = input.tasks.filter((item) => {
    const searchable = toSearchableText(item);
    return includesKeyword(searchable, bugKeywords) && includesKeyword(searchable, highImpactKeywords);
  }).length;
  const bugFixPrsMerged = mergedPrs.filter((item) => includesKeyword(toSearchableText(item), bugKeywords)).length;
  const securityRelatedChanges =
    input.tasks.filter((item) => includesKeyword(toSearchableText(item), securityKeywords)).length +
    mergedPrs.filter((item) => includesKeyword(toSearchableText(item), securityKeywords)).length;

  const reviewEvents = reviewedPrs.reduce((total, item) => total + extractReviewEvents(item.summary), 0);
  const approvalsGiven = reviewedPrs.reduce((total, item) => total + extractApprovals(item.summary), 0);

  const uniqueRepos = new Set<string>();
  for (const item of input.code) {
    const repository = extractRepository(item.summary);
    if (repository) {
      uniqueRepos.add(repository);
    }
  }

  return {
    totals: {
      tasksCompleted: input.tasks.length,
      mergedPrs: mergedPrs.length,
      reviewedPrs: reviewedPrs.length,
      totalEvidenceItems: input.tasks.length + input.comms.length + input.code.length,
      uniqueReposTouched: uniqueRepos.size,
    },
    quality: {
      bugLikeTasksResolved,
      highValueBugTasksResolved,
      bugFixPrsMerged,
      securityRelatedChanges,
    },
    collaboration: {
      reviewEvents,
      approvalsGiven,
    },
  };
}

export function renderStatsBlockMarkdown(stats: ComputedStats): string {
  return [
    "## Evidence Snapshot",
    "",
    "### Totals",
    "",
    `- Tasks completed: ${stats.totals.tasksCompleted}`,
    `- Pull requests merged: ${stats.totals.mergedPrs}`,
    `- Pull requests reviewed: ${stats.totals.reviewedPrs}`,
    `- Unique repositories touched: ${stats.totals.uniqueReposTouched}`,
    `- Total evidence items: ${stats.totals.totalEvidenceItems}`,
    "",
    "### Quality Signals",
    "",
    `- Bug-like tasks resolved: ${stats.quality.bugLikeTasksResolved}`,
    `- High-value bug tasks resolved: ${stats.quality.highValueBugTasksResolved}`,
    `- Bug-fix pull requests merged: ${stats.quality.bugFixPrsMerged}`,
    `- Security-related changes: ${stats.quality.securityRelatedChanges}`,
    "",
    "### Collaboration Signals",
    "",
    `- Review events recorded: ${stats.collaboration.reviewEvents}`,
    `- Approvals given: ${stats.collaboration.approvalsGiven}`,
    "",
    "### Method",
    "",
    "- Metrics are deterministic and computed from collected evidence fields.",
    "- Bug/high-value/security metrics use keyword rules over task/PR title+summary text.",
    "- Review events and approvals are parsed from structured review summaries returned by GitHub provider.",
    "",
  ].join("\n");
}

export function renderSynthesisBriefingMarkdown(stats: ComputedStats): string {
  return [
    "## Deterministic evidence summary (trust these counts)",
    "",
    `- Tasks completed: ${stats.totals.tasksCompleted}`,
    `- Pull requests merged: ${stats.totals.mergedPrs}`,
    `- Pull requests reviewed: ${stats.totals.reviewedPrs}`,
    `- Total evidence items: ${stats.totals.totalEvidenceItems}`,
    `- Unique repositories touched: ${stats.totals.uniqueReposTouched}`,
    `- Bug-like tasks resolved: ${stats.quality.bugLikeTasksResolved}`,
    `- High-value bug tasks resolved: ${stats.quality.highValueBugTasksResolved}`,
    `- Bug-fix pull requests merged: ${stats.quality.bugFixPrsMerged}`,
    `- Security-related changes: ${stats.quality.securityRelatedChanges}`,
    `- Review events recorded: ${stats.collaboration.reviewEvents}`,
    `- Approvals given: ${stats.collaboration.approvalsGiven}`,
    "",
  ].join("\n");
}

export function renderStatsMarkdown(config: ReviewConfig, stats: ComputedStats): string {
  return [
    `# Performance Statistics — ${config.subject.displayName}`,
    "",
    `- Timeframe: ${config.timeframe.label}`,
    `- Generated by: im-sorry-dave-youre-fired`,
    "",
    "## Totals",
    "",
    `- Tasks completed: ${stats.totals.tasksCompleted}`,
    `- Pull requests merged: ${stats.totals.mergedPrs}`,
    `- Pull requests reviewed: ${stats.totals.reviewedPrs}`,
    `- Unique repositories touched: ${stats.totals.uniqueReposTouched}`,
    `- Total evidence items: ${stats.totals.totalEvidenceItems}`,
    "",
    "## Quality Signals",
    "",
    `- Bug-like tasks resolved: ${stats.quality.bugLikeTasksResolved}`,
    `- High-value bug tasks resolved: ${stats.quality.highValueBugTasksResolved}`,
    `- Bug-fix pull requests merged: ${stats.quality.bugFixPrsMerged}`,
    `- Security-related changes: ${stats.quality.securityRelatedChanges}`,
    "",
    "## Collaboration Signals",
    "",
    `- Review events recorded: ${stats.collaboration.reviewEvents}`,
    `- Approvals given: ${stats.collaboration.approvalsGiven}`,
    "",
    "## Method",
    "",
    "- Metrics are deterministic and computed from collected evidence fields.",
    "- Bug/high-value/security metrics use keyword rules over task/PR title+summary text.",
    "- Review events and approvals are parsed from structured review summaries returned by GitHub provider.",
    "",
  ].join("\n");
}
