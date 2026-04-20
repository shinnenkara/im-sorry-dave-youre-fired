import { mkdir, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

import { generateReviewQueryPlan } from "../ai/plan.js";
import { resolveModels } from "../ai/models.js";
import { synthesizePerformanceReview } from "../ai/synthesize.js";
import type { ReviewConfig } from "../config/types.js";
import { renderEvidenceForPrompt } from "../normalize/evidence.js";
import { computeEvidenceStats, renderStatsBlockMarkdown } from "../stats/compute.js";
import type { NormalizedEvidence } from "../providers/contracts.js";
import { ProviderFactory } from "../providers/providerFactory.js";

type PhaseName = "planning" | "gathering" | "synthesis" | "output";
type EventLevel = "info" | "warn" | "error";

export interface PipelineEvent {
  phase: PhaseName;
  level: EventLevel;
  message: string;
  /** When true, the UI keeps this phase in "running" (no immediate success tick). */
  intermediate?: boolean;
  /** Stable identifier for long-running log rows that should update in place. */
  operationId?: string;
  /** Operation lifecycle state used by the UI spinner log. */
  operationState?: "running" | "done";
}

export interface PipelineRunOptions {
  config: ReviewConfig;
  dryRun: boolean;
  onEvent?: (event: PipelineEvent) => void;
}

export interface PipelineRunResult {
  outputPath?: string;
  referencesPath?: string;
  reviewMarkdown?: string;
  warnings: string[];
  evidence: {
    tasks: NormalizedEvidence[];
    comms: NormalizedEvidence[];
    code: NormalizedEvidence[];
  };
}

function emit(onEvent: PipelineRunOptions["onEvent"], event: PipelineEvent): void {
  onEvent?.(event);
}

/** Emits start/finish events for long-running operations. */
async function runOperationWithProgress<T>(
  onEvent: PipelineRunOptions["onEvent"],
  phase: PhaseName,
  opts: {
    operationId: string;
    startMessage: string;
    successMessage: string;
    failureMessage?: string;
  },
  fn: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  emit(onEvent, {
    phase,
    level: "info",
    message: opts.startMessage,
    intermediate: true,
    operationId: opts.operationId,
    operationState: "running",
  });
  try {
    const result = await fn();
    const elapsedSec = Math.floor((Date.now() - startedAt) / 1000);
    emit(onEvent, {
      phase,
      level: "info",
      message: `${opts.successMessage} after ${elapsedSec}s`,
      intermediate: true,
      operationId: opts.operationId,
      operationState: "done",
    });
    return result;
  } catch (error) {
    const elapsedSec = Math.floor((Date.now() - startedAt) / 1000);
    emit(onEvent, {
      phase,
      level: "warn",
      message: `${opts.failureMessage ?? opts.successMessage} after ${elapsedSec}s`,
      intermediate: true,
      operationId: opts.operationId,
      operationState: "done",
    });
    throw error;
  }
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

function buildEvidenceByCitation(items: readonly NormalizedEvidence[]): Map<string, NormalizedEvidence> {
  const index = new Map<string, NormalizedEvidence>();
  for (const item of items) {
    if (!index.has(item.citation)) {
      index.set(item.citation, item);
    }
  }
  return index;
}

interface CitationParts {
  prefix: string;
  number: number;
}

function parseCitationParts(citation: string): CitationParts | undefined {
  const match = /^([A-Z]+)-(\d+)$/.exec(citation);
  if (!match) {
    return undefined;
  }
  const prefixRaw = match[1];
  const numberRaw = match[2];
  if (!prefixRaw || !numberRaw) {
    return undefined;
  }
  const prefix = prefixRaw;
  const number = Number.parseInt(numberRaw, 10);
  if (!Number.isInteger(number) || number <= 0) {
    return undefined;
  }
  return { prefix, number };
}

function citationGroupLabel(prefix: string): string {
  const labels: Record<string, string> = {
    TASK: "Tasks",
    TICKET: "Tasks",
    COMM: "Communications",
    PR: "Pull Requests",
    REVIEW: "Code Reviews",
  };
  return labels[prefix] ?? prefix;
}

function extractUsedCitations(reviewText: string): string[] {
  const citations: string[] = [];
  const seen = new Set<string>();
  const addCitation = (value: string): void => {
    if (seen.has(value)) {
      return;
    }
    seen.add(value);
    citations.push(value);
  };

  const rangePattern = /\[([A-Z]+)-(\d+)\]\s+(?:through|to)\s+\[\1-(\d+)\]/g;
  for (const match of reviewText.matchAll(rangePattern)) {
    const [, prefix, startRaw, endRaw] = match;
    if (!prefix || !startRaw || !endRaw) {
      continue;
    }
    const start = Number.parseInt(startRaw, 10);
    const end = Number.parseInt(endRaw, 10);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start <= 0 || end <= 0) {
      continue;
    }
    const low = Math.min(start, end);
    const high = Math.max(start, end);
    if (high - low > 500) {
      continue;
    }
    for (let current = low; current <= high; current += 1) {
      addCitation(`${prefix}-${current}`);
    }
  }

  const bracketPattern = /\[([^\]]+)\]/g;
  for (const match of reviewText.matchAll(bracketPattern)) {
    const content = match[1];
    if (!content) {
      continue;
    }
    const parts = content.split(",");
    for (const part of parts) {
      const token = part.trim();
      if (!/^[A-Z]+-\d+$/.test(token)) {
        continue;
      }
      addCitation(token);
    }
  }

  return citations;
}

function renderReferencesMarkdown(reviewText: string, items: readonly NormalizedEvidence[]): string {
  const usedCitations = extractUsedCitations(reviewText);
  if (usedCitations.length === 0) {
    return "";
  }

  const evidenceByCitation = buildEvidenceByCitation(items);
  const grouped = new Map<string, string[]>();
  const unknownOrder: string[] = [];
  const seenUnknown = new Set<string>();
  for (const citation of usedCitations) {
    const parsed = parseCitationParts(citation);
    if (!parsed) {
      if (!seenUnknown.has(citation)) {
        seenUnknown.add(citation);
        unknownOrder.push(citation);
      }
      continue;
    }
    const bucket = grouped.get(parsed.prefix);
    if (bucket) {
      bucket.push(citation);
      continue;
    }
    grouped.set(parsed.prefix, [citation]);
  }

  const preferredPrefixOrder = ["PR", "REVIEW", "TASK", "TICKET", "COMM"];
  const availablePrefixes = [...grouped.keys()];
  availablePrefixes.sort((left, right) => {
    const leftIndex = preferredPrefixOrder.indexOf(left);
    const rightIndex = preferredPrefixOrder.indexOf(right);
    if (leftIndex !== -1 || rightIndex !== -1) {
      if (leftIndex === -1) {
        return 1;
      }
      if (rightIndex === -1) {
        return -1;
      }
      return leftIndex - rightIndex;
    }
    return left.localeCompare(right);
  });

  const lines = ["## References", ""];

  for (const prefix of availablePrefixes) {
    lines.push(`### ${citationGroupLabel(prefix)}`);
    lines.push("");
    const citations = grouped.get(prefix) ?? [];
    citations.sort((left, right) => {
      const leftParts = parseCitationParts(left);
      const rightParts = parseCitationParts(right);
      if (!leftParts || !rightParts) {
        return left.localeCompare(right);
      }
      return leftParts.number - rightParts.number;
    });
    for (const citation of citations) {
      const evidence = evidenceByCitation.get(citation);
      if (!evidence) {
        lines.push(`- [${citation}] Referenced in review, but no matching evidence item was found.`);
        continue;
      }

      const details = [evidence.title.trim()];
      if (evidence.url) {
        details.push(`<${evidence.url}>`);
      } else {
        details.push("(no URL available)");
      }
      lines.push(`- [${citation}] ${details.join(" — ")}`);
    }
    lines.push("");
  }

  if (unknownOrder.length > 0) {
    lines.push("### Other");
    lines.push("");
    for (const citation of unknownOrder) {
      const evidence = evidenceByCitation.get(citation);
      if (!evidence) {
        lines.push(`- [${citation}] Referenced in review, but no matching evidence item was found.`);
        continue;
      }
      const details = [evidence.title.trim()];
      if (evidence.url) {
        details.push(`<${evidence.url}>`);
      } else {
        details.push("(no URL available)");
      }
      lines.push(`- [${citation}] ${details.join(" — ")}`);
    }
    lines.push("");
  }

  lines.push("");
  return lines.join("\n");
}

function formatMarkdown(
  config: ReviewConfig,
  reviewText: string,
  evidenceCounts: { tasks: number; comms: number; code: number },
  statsBlockMarkdown: string,
): string {
  return [
    `# Performance Review — ${config.subject.displayName}`,
    "",
    reviewText,
    "",
    "---",
    "",
    "## Review Metadata",
    "",
    `- Timeframe: ${config.timeframe.label}`,
    `- Generated by: im-sorry-dave-youre-fired`,
    `- Evidence counts: tasks=${evidenceCounts.tasks}, comms=${evidenceCounts.comms}, code=${evidenceCounts.code}`,
    "",
    statsBlockMarkdown,
    "",
  ].join("\n");
}

function renderQuestionStrategyGuidance(
  questions: readonly string[],
  strategies: readonly { questionIndex: number; evidenceStrategy: "aggregate" | "mixed" | "narrative" }[],
): string {
  if (strategies.length === 0) {
    return "";
  }

  const lines = ["## Planner strategy hints", ""];
  for (const strategy of strategies) {
    const question = questions[strategy.questionIndex - 1];
    if (!question) {
      continue;
    }
    lines.push(`- Q${strategy.questionIndex}: ${strategy.evidenceStrategy} — ${question}`);
  }
  if (lines.length === 2) {
    return "";
  }
  lines.push("");
  return lines.join("\n");
}

async function collectWithProgress(
  onEvent: PipelineRunOptions["onEvent"],
  opts: {
    operationId: string;
    label: string;
    successLabel: string;
    failurePrefix: string;
    warnings: string[];
  },
  run: () => Promise<NormalizedEvidence[]>,
): Promise<NormalizedEvidence[]> {
  const startedAt = Date.now();
  emit(onEvent, {
    phase: "gathering",
    level: "info",
    message: `${opts.label}: running`,
    intermediate: true,
    operationId: opts.operationId,
    operationState: "running",
  });
  try {
    const items = await run();
    const elapsedSec = Math.floor((Date.now() - startedAt) / 1000);
    emit(onEvent, {
      phase: "gathering",
      level: "info",
      message: `${opts.successLabel} after ${elapsedSec}s (${items.length} items)`,
      intermediate: true,
      operationId: opts.operationId,
      operationState: "done",
    });
    return items;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const warning = `${opts.failurePrefix}: ${message}`;
    opts.warnings.push(warning);
    emit(onEvent, { phase: "gathering", level: "warn", message: warning });
    const elapsedSec = Math.floor((Date.now() - startedAt) / 1000);
    emit(onEvent, {
      phase: "gathering",
      level: "warn",
      message: `${opts.label}: failed after ${elapsedSec}s`,
      intermediate: true,
      operationId: opts.operationId,
      operationState: "done",
    });
    return [];
  }
}

export async function runReviewPipeline(options: PipelineRunOptions): Promise<PipelineRunResult> {
  const { config, dryRun, onEvent } = options;
  const warnings: string[] = [];
  const models = resolveModels(config);
  const providers = new ProviderFactory(config).build();

  emit(onEvent, {
    phase: "planning",
    level: "info",
    message: `Planning with model ${models.fast}`,
    intermediate: true,
  });
  const queryPlan = await runOperationWithProgress(
    onEvent,
    "planning",
    {
      operationId: "planning:model-api",
      startMessage: "Awaiting structured planner response from the model API…",
      successMessage: "Planner API request finished",
      failureMessage: "Planner API request failed",
    },
    () => generateReviewQueryPlan(config, models.fast),
  );
  emit(onEvent, {
    phase: "planning",
    level: "info",
    message: `Planner generated queries (tasks=${queryPlan.providerQueries.tasks.length}, comms=${queryPlan.providerQueries.comms.length}, code=${queryPlan.providerQueries.code.length})`,
  });
  const questionStrategyGuidance = renderQuestionStrategyGuidance(config.reviewQuestions, queryPlan.questionStrategies);

  emit(onEvent, { phase: "gathering", level: "info", message: "Collecting provider evidence in parallel" });
  const [tasks, comms, mergedPrs, reviews] = await Promise.all([
    providers.taskProvider
      ? collectWithProgress(
          onEvent,
          {
            operationId: "gathering:tasks",
            label: "Task provider",
            successLabel: "Task provider completed",
            failurePrefix: "Task provider failed",
            warnings,
          },
          () =>
            providers.taskProvider!.getCompletedTasks({
              subject: config.subject,
              timeframe: config.timeframe.providerScope,
              queries: queryPlan.providerQueries.tasks,
            }),
        )
      : Promise.resolve([]),
    providers.commProvider
      ? collectWithProgress(
          onEvent,
          {
            operationId: "gathering:comms",
            label: "Comm provider",
            successLabel: "Comm provider completed",
            failurePrefix: "Comm provider failed",
            warnings,
          },
          () =>
            providers.commProvider!.getConversations({
              subject: config.subject,
              timeframe: config.timeframe.providerScope,
              queries: queryPlan.providerQueries.comms,
            }),
        )
      : Promise.resolve([]),
    providers.codeProvider
      ? collectWithProgress(
          onEvent,
          {
            operationId: "gathering:code-prs",
            label: "Code provider PR fetch",
            successLabel: "Code provider PR fetch completed",
            failurePrefix: "Code provider PR fetch failed",
            warnings,
          },
          () =>
            providers.codeProvider!.getMergedPRs({
              subject: config.subject,
              timeframe: config.timeframe.providerScope,
              queries: queryPlan.providerQueries.code,
            }),
        )
      : Promise.resolve([]),
    providers.codeProvider
      ? collectWithProgress(
          onEvent,
          {
            operationId: "gathering:code-reviews",
            label: "Code provider review fetch",
            successLabel: "Code provider review fetch completed",
            failurePrefix: "Code provider review fetch failed",
            warnings,
          },
          () =>
            providers.codeProvider!.getCodeReviews({
              subject: config.subject,
              timeframe: config.timeframe.providerScope,
              queries: queryPlan.providerQueries.code,
            }),
        )
      : Promise.resolve([]),
  ]);

  const code = [...mergedPrs, ...reviews];
  emit(onEvent, {
    phase: "gathering",
    level: "info",
    message: `Evidence totals: tasks=${tasks.length}, comms=${comms.length}, code=${code.length}`,
  });
  const stats = computeEvidenceStats({ tasks, comms, code });

  if (dryRun) {
    emit(onEvent, { phase: "output", level: "info", message: "Dry run complete; skipped synthesis and file output" });
    return {
      warnings,
      evidence: { tasks, comms, code },
    };
  }

  emit(onEvent, {
    phase: "synthesis",
    level: "info",
    message: `Synthesizing with model ${models.pro}`,
    intermediate: true,
  });
  const context = [
    "## Tasks evidence",
    renderEvidenceForPrompt(tasks),
    "",
    "## Communications evidence",
    renderEvidenceForPrompt(comms),
    "",
    "## Code evidence",
    renderEvidenceForPrompt(code),
  ].join("\n");
  const maxContextChars = config.maxContextChars;
  const trimmedContext = context.slice(0, maxContextChars);
  const reviewMarkdownBody = await runOperationWithProgress(
    onEvent,
    "synthesis",
    {
      operationId: "synthesis:model-api",
      startMessage: "Awaiting synthesis response from the model API…",
      successMessage: "Synthesis API request finished",
      failureMessage: "Synthesis API request failed",
    },
    () =>
      synthesizePerformanceReview({
        config,
        modelId: models.pro,
        evidenceContext: trimmedContext,
        questionStrategyMarkdown: questionStrategyGuidance,
      }),
  );
  emit(onEvent, { phase: "synthesis", level: "info", message: "Synthesis response received; drafting complete" });

  emit(onEvent, { phase: "output", level: "info", message: "Writing markdown output" });
  const outDir = resolve(config.outDir);
  await mkdir(outDir, { recursive: true });
  const outputPrefix = `performance_review_${slugify(config.subject.displayName)}_${config.timeframe.slug}`;
  const outputPath = resolve(outDir, basename(`${outputPrefix}.md`));
  const allEvidence = [...tasks, ...comms, ...code];
  const referencesMarkdown = renderReferencesMarkdown(reviewMarkdownBody, allEvidence);
  const statsBlockMarkdown = renderStatsBlockMarkdown(stats);
  const finalMarkdown = formatMarkdown(config, reviewMarkdownBody, {
    tasks: tasks.length,
    comms: comms.length,
    code: code.length,
  }, statsBlockMarkdown);
  const referencesPath = resolve(outDir, basename(`${outputPrefix}_references.md`));
  await writeFile(outputPath, finalMarkdown, "utf8");
  if (referencesMarkdown) {
    await writeFile(referencesPath, referencesMarkdown, "utf8");
    emit(onEvent, { phase: "output", level: "info", message: `Wrote references to ${referencesPath}` });
  }

  emit(onEvent, { phase: "output", level: "info", message: `Wrote review to ${outputPath}` });
  return {
    outputPath,
    referencesPath: referencesMarkdown ? referencesPath : undefined,
    reviewMarkdown: finalMarkdown,
    warnings,
    evidence: { tasks, comms, code },
  };
}
