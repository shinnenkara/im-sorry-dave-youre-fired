import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { execa } from "execa";

import { normalizeTextChunks } from "../normalize/evidence.js";

import type { ICodeProvider, NormalizedEvidence, ProviderQueryRequest } from "./contracts.js";

interface GhPrSearchResult {
  number: number;
  title: string;
  url: string;
  closedAt?: string;
  createdAt?: string;
  mergedAt?: string;
  updatedAt?: string;
  state?: string;
  repository?: {
    nameWithOwner?: string;
  };
}

interface GhActor {
  login?: string;
  name?: string;
}

interface GhLabel {
  name?: string;
}

interface GhComment {
  author?: GhActor;
  body?: string;
  createdAt?: string;
  url?: string;
}

interface GhReview {
  author?: GhActor;
  state?: string;
  submittedAt?: string;
  body?: string;
}

interface GhReviewRequest {
  requestedReviewer?: {
    login?: string;
    name?: string;
    slug?: string;
  };
}

interface GhPrDetailResult extends GhPrSearchResult {
  body?: string;
  author?: GhActor;
  assignees?: GhActor[];
  labels?: GhLabel[];
  comments?: GhComment[];
  reviews?: GhReview[];
  reviewRequests?: GhReviewRequest[];
}

export interface GitHubCliProviderOptions {
  repo?: string | string[];
  debugOutputPath?: string;
  prLimit: number;
}

type DebugKind = "mergedPRs" | "codeReviews";

interface GhSearchDebugEntry {
  query: string;
  repoFilter?: string;
  limit: number;
  rawResultCount: number;
  rawRows: GhPrSearchResult[];
}

interface GhDebugSnapshot {
  timeframe: string;
  subject: string;
  plannerQueries: string[];
  deduplicatedRowCount: number;
  searches: GhSearchDebugEntry[];
  rows: GhPrDetailResult[];
  appliedDateQualifier?: string;
  postFilterDroppedCount?: number;
  fallbackApplied?: boolean;
}

interface TimeframeWindow {
  startDate: string;
  endDate: string;
}

function sanitizePlannerQueryBit(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }

  // Keep search qualifiers controlled by adapter-level filters only.
  const withoutQualifiers = trimmed
    .replace(/\b[a-z][a-z-]*:(?:"[^"]*"|\S+)/giu, " ")
    .replace(/[()]/g, " ")
    .replace(/\b(AND|OR|NOT)\b/giu, " ")
    .replace(/["']/g, " ")
    .replace(/[^a-z0-9\s-]/giu, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!withoutQualifiers) {
    return undefined;
  }

  // Bound planner expansion to avoid GitHub's boolean/query complexity limits.
  const terms = withoutQualifiers.split(/\s+/u).filter(Boolean);
  if (terms.length === 0) {
    return undefined;
  }
  return terms.slice(0, 8).join(" ");
}

function stopwordSet(): Set<string> {
  return new Set([
    "the",
    "and",
    "for",
    "with",
    "that",
    "this",
    "from",
    "into",
    "across",
    "through",
    "about",
    "within",
    "their",
    "review",
    "reviews",
    "pull",
    "request",
    "requests",
    "pr",
    "prs",
  ]);
}

function buildKeywordQueryBits(plannerQueries: string[], displayName: string): string[] {
  const excluded = new Set(
    displayName
      .toLowerCase()
      .split(/\s+/u)
      .map((token) => token.trim())
      .filter(Boolean),
  );
  const stopwords = stopwordSet();
  const keywords: string[] = [];
  const seen = new Set<string>();

  for (const raw of plannerQueries) {
    const sanitized = sanitizePlannerQueryBit(raw);
    if (!sanitized) {
      continue;
    }
    for (const token of sanitized.split(/\s+/u)) {
      const normalized = token.toLowerCase();
      if (normalized.length < 3 || excluded.has(normalized) || stopwords.has(normalized) || seen.has(normalized)) {
        continue;
      }
      seen.add(normalized);
      keywords.push(token);
      if (keywords.length >= 8) {
        return [keywords.join(" ")];
      }
    }
  }

  return keywords.length > 0 ? [keywords.join(" ")] : [];
}

function normalizeRepoFilters(repo?: string | string[]): string[] {
  if (!repo) {
    return [];
  }
  const repos = (Array.isArray(repo) ? repo : [repo]).map((entry) => entry.trim()).filter(Boolean);
  const filters = repos.map((entry) => {
    if (entry.startsWith("repo:")) {
      return entry;
    }
    if (entry.includes("/")) {
      return `repo:${entry}`;
    }
    throw new Error(`Invalid GitHub repo "${entry}". Use "owner/repo" (for example "carbmee/carbmee").`);
  });
  return [...new Set(filters)];
}

function parseTimeframeWindow(timeframe: string): TimeframeWindow | undefined {
  const match = timeframe.match(/\b(\d{4}-\d{2}-\d{2})\s+to\s+(\d{4}-\d{2}-\d{2})\b/u);
  if (!match) {
    return undefined;
  }
  const [, startDate, endDate] = match;
  if (!startDate || !endDate) {
    return undefined;
  }
  return { startDate, endDate };
}

function toIsoCalendarDate(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.length >= 10 ? value.slice(0, 10) : value;
  return /^\d{4}-\d{2}-\d{2}$/u.test(normalized) ? normalized : undefined;
}

function isWithinWindow(value: string | undefined, window: TimeframeWindow): boolean {
  const date = toIsoCalendarDate(value);
  if (!date) {
    return false;
  }
  return date >= window.startDate && date <= window.endDate;
}

async function runGhJson<T>(args: string[]): Promise<{ parsed: T; stdout: string }> {
  const result = await execa("gh", args);
  return {
    parsed: JSON.parse(result.stdout) as T,
    stdout: result.stdout,
  };
}

function toSingleLine(value: string, max = 220): string {
  const compacted = value.replace(/\s+/gu, " ").trim();
  if (compacted.length <= max) {
    return compacted;
  }
  return `${compacted.slice(0, max - 1)}...`;
}

function actorLabel(actor?: GhActor): string {
  if (!actor?.login && !actor?.name) {
    return "unknown";
  }
  if (actor.name && actor.login) {
    return `${actor.name} (@${actor.login})`;
  }
  return actor.name ?? `@${actor.login}`;
}

function extractLabelNames(row: GhPrDetailResult): string[] {
  const names = row.labels?.map((label) => label.name?.trim()).filter((name): name is string => Boolean(name)) ?? [];
  return [...new Set(names)];
}

function formatReviewRequests(row: GhPrDetailResult): string | undefined {
  const requests = row.reviewRequests ?? [];
  if (requests.length === 0) {
    return undefined;
  }
  const requested = requests
    .map((request) => {
      const reviewer = request.requestedReviewer;
      if (!reviewer) {
        return undefined;
      }
      if (reviewer.name && reviewer.login) {
        return `${reviewer.name} (@${reviewer.login})`;
      }
      if (reviewer.login) {
        return `@${reviewer.login}`;
      }
      if (reviewer.slug) {
        return `team:${reviewer.slug}`;
      }
      return reviewer.name;
    })
    .filter((value): value is string => Boolean(value));
  return requested.length > 0 ? requested.join(", ") : undefined;
}

function formatReviewSummary(row: GhPrDetailResult): string | undefined {
  const reviews = row.reviews ?? [];
  if (reviews.length === 0) {
    return undefined;
  }
  const recent = reviews.slice(0, 3).map((review) => {
    const state = review.state ?? "COMMENTED";
    const author = actorLabel(review.author);
    const body = review.body ? `: ${toSingleLine(review.body, 120)}` : "";
    return `${state} by ${author}${body}`;
  });
  return `${reviews.length} total; ${recent.join(" | ")}`;
}

function formatCommentSummary(row: GhPrDetailResult): string | undefined {
  const comments = row.comments ?? [];
  if (comments.length === 0) {
    return undefined;
  }
  const recent = comments.slice(0, 3).map((comment) => {
    const author = actorLabel(comment.author);
    const body = comment.body ? toSingleLine(comment.body, 140) : "(empty)";
    return `${author}: ${body}`;
  });
  return `${comments.length} total; ${recent.join(" | ")}`;
}

function toEvidence(prefix: string, source: "code", rows: GhPrDetailResult[]): NormalizedEvidence[] {
  const chunks = rows.map((row) => {
    const repo = row.repository?.nameWithOwner ?? "unknown-repo";
    const assignees = row.assignees?.map((assignee) => actorLabel(assignee)).filter(Boolean).join(", ");
    const labels = extractLabelNames(row);
    const reviewRequests = formatReviewRequests(row);
    const reviews = formatReviewSummary(row);
    const comments = formatCommentSummary(row);
    return [
      `${row.title} (#${row.number})`,
      `Repository: ${repo}`,
      `URL: ${row.url}`,
      row.author ? `Author: ${actorLabel(row.author)}` : undefined,
      row.state ? `State: ${row.state}` : undefined,
      row.createdAt ? `OpenedAt: ${row.createdAt}` : undefined,
      row.closedAt ? `ClosedAt: ${row.closedAt}` : undefined,
      row.mergedAt ? `MergedAt: ${row.mergedAt}` : undefined,
      assignees ? `Assignees: ${assignees}` : undefined,
      labels.length > 0 ? `Labels: ${labels.join(", ")}` : undefined,
      reviewRequests ? `ReviewRequests: ${reviewRequests}` : undefined,
      reviews ? `Reviews: ${reviews}` : undefined,
      comments ? `Comments: ${comments}` : undefined,
      row.body ? `Description: ${toSingleLine(row.body, 600)}` : undefined,
    ]
      .filter(Boolean)
      .join("\n");
  });
  return normalizeTextChunks(source, chunks, prefix).map((item, index) => ({
    ...item,
    url: rows[index]?.url,
    occurredAt: rows[index]?.mergedAt ?? rows[index]?.closedAt ?? rows[index]?.createdAt,
    tags: rows[index] ? extractLabelNames(rows[index]) : undefined,
  }));
}

export class GitHubCliAdapter implements ICodeProvider {
  public readonly name = "github-cli";
  private readonly repoFilters: string[];
  private readonly debugOutputPath?: string;
  private readonly prLimit: number;
  private readonly debugSnapshots: Partial<Record<DebugKind, GhDebugSnapshot>> = {};

  public constructor(options: GitHubCliProviderOptions) {
    this.repoFilters = normalizeRepoFilters(options.repo);
    this.debugOutputPath = options.debugOutputPath;
    this.prLimit = options.prLimit;
  }

  private async writeDebugOutput(): Promise<void> {
    if (!this.debugOutputPath) {
      return;
    }
    await mkdir(dirname(this.debugOutputPath), { recursive: true });
    const payload = {
      provider: this.name,
      generatedAt: new Date().toISOString(),
      repoFilters: this.repoFilters,
      prLimit: this.prLimit,
      mergedPRs: this.debugSnapshots.mergedPRs,
      codeReviews: this.debugSnapshots.codeReviews,
    };
    await writeFile(this.debugOutputPath, JSON.stringify(payload, null, 2), "utf8");
  }

  private async runSearchAcrossRepoFilters(baseQueryBits: string[]): Promise<{
    deduplicatedRows: GhPrSearchResult[];
    debugEntries: GhSearchDebugEntry[];
  }> {
    const debugEntries: GhSearchDebugEntry[] = [];
    const repoFilters = this.repoFilters.length > 0 ? this.repoFilters : [undefined];
    const allRows: GhPrSearchResult[] = [];
    for (const repoFilter of repoFilters) {
      const queryTerms = [...baseQueryBits, ...(repoFilter ? [repoFilter] : [])].map((bit) => bit.trim()).filter(Boolean);
      const query = queryTerms.join(" ");
      const { parsed } = await runGhJson<GhPrSearchResult[]>([
        "search",
        "prs",
        ...queryTerms,
        "--limit",
        String(this.prLimit),
        "--json",
        "number,title,url,state,createdAt,updatedAt,closedAt,repository",
      ]);
      debugEntries.push({
        query,
        repoFilter,
        limit: this.prLimit,
        rawResultCount: parsed.length,
        rawRows: parsed,
      });
      for (const row of parsed) {
        allRows.push(row);
      }
    }

    const deduplicated = new Map<string, GhPrSearchResult>();
    for (const row of allRows) {
      const key = row.url || `${row.repository?.nameWithOwner ?? "unknown"}#${row.number}`;
      if (!deduplicated.has(key)) {
        deduplicated.set(key, row);
      }
    }
    return {
      deduplicatedRows: [...deduplicated.values()].slice(0, this.prLimit),
      debugEntries,
    };
  }

  private async fetchPrDetails(row: GhPrSearchResult): Promise<GhPrDetailResult> {
    const { parsed } = await runGhJson<GhPrDetailResult>([
      "pr",
      "view",
      row.url,
      "--json",
      "number,title,url,state,createdAt,updatedAt,closedAt,mergedAt,author,assignees,labels,body,reviewRequests,reviews,comments",
    ]);
    return {
      ...row,
      ...parsed,
      repository: parsed.repository ?? row.repository,
      comments: parsed.comments ?? [],
      reviews: parsed.reviews ?? [],
      reviewRequests: parsed.reviewRequests ?? [],
      assignees: parsed.assignees ?? [],
      labels: parsed.labels ?? [],
    };
  }

  private async enrichRows(rows: GhPrSearchResult[]): Promise<GhPrDetailResult[]> {
    if (rows.length === 0) {
      return [];
    }

    const enriched: GhPrDetailResult[] = [];
    const concurrency = 5;
    for (let index = 0; index < rows.length; index += concurrency) {
      const batch = rows.slice(index, index + concurrency);
      const results = await Promise.allSettled(batch.map((row) => this.fetchPrDetails(row)));
      for (const [batchIndex, result] of results.entries()) {
        const fallbackRow = batch[batchIndex];
        if (!fallbackRow) {
          continue;
        }
        if (result.status === "fulfilled") {
          enriched.push(result.value);
          continue;
        }
        enriched.push(fallbackRow);
      }
    }
    return enriched;
  }

  public async getMergedPRs(request: ProviderQueryRequest): Promise<NormalizedEvidence[]> {
    const author = request.subject.githubUsername ?? request.subject.displayName;
    const window = parseTimeframeWindow(request.timeframe);
    const dateQualifier = window ? `closed:${window.startDate}..${window.endDate}` : undefined;
    const baseQueryBits = [`author:${author}`, "is:pr", "is:merged", ...(dateQualifier ? [dateQualifier] : [])];
    const keywordBits = buildKeywordQueryBits(request.queries, request.subject.displayName);
    const initialSearch = await this.runSearchAcrossRepoFilters([...baseQueryBits, ...keywordBits]);
    const shouldFallback = keywordBits.length > 0 && initialSearch.deduplicatedRows.length === 0;
    const fallbackSearch = shouldFallback ? await this.runSearchAcrossRepoFilters(baseQueryBits) : undefined;
    const finalRows = fallbackSearch?.deduplicatedRows ?? initialSearch.deduplicatedRows;
    const debugEntries = fallbackSearch
      ? [...initialSearch.debugEntries, ...fallbackSearch.debugEntries]
      : initialSearch.debugEntries;
    const enrichedRows = await this.enrichRows(finalRows);
    const filteredRows = window
      ? enrichedRows.filter((row) =>
          isWithinWindow(row.mergedAt ?? row.closedAt ?? row.updatedAt ?? row.createdAt, window),
        )
      : enrichedRows;
    const evidence = toEvidence("PR", "code", filteredRows);
    this.debugSnapshots.mergedPRs = {
      timeframe: request.timeframe,
      subject: author,
      plannerQueries: request.queries,
      deduplicatedRowCount: filteredRows.length,
      searches: debugEntries,
      rows: filteredRows,
      appliedDateQualifier: dateQualifier,
      postFilterDroppedCount: enrichedRows.length - filteredRows.length || undefined,
      fallbackApplied: shouldFallback || undefined,
    };
    await this.writeDebugOutput();

    return evidence;
  }

  public async getCodeReviews(request: ProviderQueryRequest): Promise<NormalizedEvidence[]> {
    const reviewer = request.subject.githubUsername ?? request.subject.displayName;
    const window = parseTimeframeWindow(request.timeframe);
    const dateQualifier = window ? `updated:${window.startDate}..${window.endDate}` : undefined;
    const baseQueryBits = [`reviewed-by:${reviewer}`, "is:pr", ...(dateQualifier ? [dateQualifier] : [])];
    const keywordBits = buildKeywordQueryBits(request.queries, request.subject.displayName);
    const initialSearch = await this.runSearchAcrossRepoFilters([...baseQueryBits, ...keywordBits]);
    const shouldFallback = keywordBits.length > 0 && initialSearch.deduplicatedRows.length === 0;
    const fallbackSearch = shouldFallback ? await this.runSearchAcrossRepoFilters(baseQueryBits) : undefined;
    const finalRows = fallbackSearch?.deduplicatedRows ?? initialSearch.deduplicatedRows;
    const debugEntries = fallbackSearch
      ? [...initialSearch.debugEntries, ...fallbackSearch.debugEntries]
      : initialSearch.debugEntries;
    const enrichedRows = await this.enrichRows(finalRows);
    const filteredRows = window
      ? enrichedRows.filter((row) =>
          isWithinWindow(row.updatedAt ?? row.closedAt ?? row.createdAt ?? row.mergedAt, window),
        )
      : enrichedRows;
    const evidence = toEvidence("REVIEW", "code", filteredRows);
    this.debugSnapshots.codeReviews = {
      timeframe: request.timeframe,
      subject: reviewer,
      plannerQueries: request.queries,
      deduplicatedRowCount: filteredRows.length,
      searches: debugEntries,
      rows: filteredRows,
      appliedDateQualifier: dateQualifier,
      postFilterDroppedCount: enrichedRows.length - filteredRows.length || undefined,
      fallbackApplied: shouldFallback || undefined,
    };
    await this.writeDebugOutput();

    return evidence;
  }
}
