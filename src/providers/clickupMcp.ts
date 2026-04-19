import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { McpServerConfig } from "../config/types.js";
import { normalizeTextChunks } from "../normalize/evidence.js";

import type { ITaskProvider, NormalizedEvidence, ProviderQueryRequest } from "./contracts.js";
import { callMcpTool, listMcpTools } from "./mcpClient.js";

export interface ClickupMcpProviderOptions {
  server: McpServerConfig;
  searchTool: string;
  userOverride?: string;
  debugOutputPath?: string;
  enrichTaskDetails?: boolean;
  maxEnrichedTasks?: number;
  enrichmentConcurrency?: number;
  maxCommentsPerTask?: number;
  enrichmentScoring?: {
    keywordWeights?: Record<string, number>;
    doneBoost?: number;
    closedBoost?: number;
    multiAssigneeBoost?: number;
    nonBugBoost?: number;
    recencyBoost?: number;
    recencyWindowDays?: number;
  };
}

interface CommentSnippet {
  author?: string;
  text: string;
  occurredAt?: string;
}

interface TaskEnrichment {
  description?: string;
  comments: CommentSnippet[];
}

interface TaskEvidenceEntry {
  evidence: NormalizedEvidence;
  task: Record<string, unknown>;
}

interface EnrichmentCandidateScore {
  score: number;
  reasons: string[];
}

export class ClickupMcpAdapter implements ITaskProvider {
  public readonly name = "clickup-mcp";
  private readonly server: McpServerConfig;
  private readonly configuredSearchTool: string;
  private readonly userOverride?: string;
  private readonly debugOutputPath?: string;
  private readonly enrichTaskDetails: boolean;
  private readonly maxEnrichedTasks: number;
  private readonly enrichmentConcurrency: number;
  private readonly maxCommentsPerTask: number;
  private readonly enrichmentScoring: {
    keywordWeights: Record<string, number>;
    doneBoost: number;
    closedBoost: number;
    multiAssigneeBoost: number;
    nonBugBoost: number;
    recencyBoost: number;
    recencyWindowDays: number;
  };
  private resolvedUserPromise?: Promise<string>;
  private resolvedSearchToolPromise?: Promise<string>;
  private resolvedAssigneeIdsPromise?: Promise<string[]>;

  public constructor(options: ClickupMcpProviderOptions) {
    this.server = options.server;
    this.configuredSearchTool = options.searchTool;
    this.userOverride = options.userOverride;
    this.debugOutputPath = options.debugOutputPath;
    this.enrichTaskDetails = options.enrichTaskDetails ?? true;
    this.maxEnrichedTasks = options.maxEnrichedTasks ?? 30;
    this.enrichmentConcurrency = options.enrichmentConcurrency ?? 6;
    this.maxCommentsPerTask = options.maxCommentsPerTask ?? 3;
    this.enrichmentScoring = {
      keywordWeights: options.enrichmentScoring?.keywordWeights ?? ClickupMcpAdapter.defaultKeywordWeights,
      doneBoost: options.enrichmentScoring?.doneBoost ?? 2,
      closedBoost: options.enrichmentScoring?.closedBoost ?? 2,
      multiAssigneeBoost: options.enrichmentScoring?.multiAssigneeBoost ?? 1.5,
      nonBugBoost: options.enrichmentScoring?.nonBugBoost ?? 1,
      recencyBoost: options.enrichmentScoring?.recencyBoost ?? 2,
      recencyWindowDays: options.enrichmentScoring?.recencyWindowDays ?? 45,
    };
  }

  private static readonly searchToolAliases: Record<string, string> = {
    search_tasks: "clickup_search",
  };

  private static readonly defaultKeywordWeights: Record<string, number> = {
    architecture: 8,
    migration: 7,
    refactor: 6,
    redesign: 6,
    design: 5,
    platform: 5,
    performance: 5,
    integration: 4,
    api: 4,
    scalability: 4,
  };

  private static extractObject(raw: string): Record<string, unknown> | null {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return null;
    }
    return null;
  }

  private static asRecord(value: unknown): Record<string, unknown> | null {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    return null;
  }

  private static asString(value: unknown): string | undefined {
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
  }

  private static compactWhitespace(value: string): string {
    return value.replace(/\s+/g, " ").trim();
  }

  private static limitText(value: string, maxChars: number): string {
    const compact = ClickupMcpAdapter.compactWhitespace(value);
    return compact.length > maxChars ? `${compact.slice(0, maxChars)}...` : compact;
  }

  private static asTimestampIso(value: unknown): string | undefined {
    const parsedNumber =
      typeof value === "number"
        ? value
        : typeof value === "string" && /^\d+$/.test(value)
          ? Number(value)
          : Number.NaN;
    if (!Number.isFinite(parsedNumber) || parsedNumber <= 0) {
      return undefined;
    }
    return new Date(parsedNumber).toISOString();
  }

  private static extractTaskObjectsFromChunk(chunk: string): Record<string, unknown>[] {
    const parsed = ClickupMcpAdapter.extractObject(chunk);
    if (!parsed) {
      return [];
    }

    const candidateArrays: unknown[] = [];
    if (Array.isArray(parsed.results)) {
      candidateArrays.push(parsed.results);
    }
    if (Array.isArray(parsed.tasks)) {
      candidateArrays.push(parsed.tasks);
    }

    for (const candidate of candidateArrays) {
      const tasks = (candidate as unknown[])
        .map((item) => ClickupMcpAdapter.asRecord(item))
        .filter((item): item is Record<string, unknown> => Boolean(item))
        .filter((item) => {
          const kind = ClickupMcpAdapter.asString(item.type);
          if (kind) {
            return kind.toLowerCase() === "task";
          }
          const url = ClickupMcpAdapter.asString(item.url);
          return typeof url === "string" && /\/t\//.test(url);
        });
      if (tasks.length > 0) {
        return tasks;
      }
    }

    return [];
  }

  private static isMcpErrorChunk(chunk: string): boolean {
    return /^mcp error\b/i.test(chunk.trim());
  }

  private static parseTimeframeDateRange(timeframe: string): { start: string; end: string } | null {
    const match = timeframe.match(/(\d{4}-\d{2}-\d{2})\s+to\s+(\d{4}-\d{2}-\d{2})/i);
    if (!match) {
      return null;
    }
    const start = match[1];
    const end = match[2];
    if (!start || !end) {
      return null;
    }
    return { start, end };
  }

  private static withinDateRange(occurredAt: string | undefined, timeframe: string): boolean {
    if (!occurredAt) {
      return true;
    }
    const range = ClickupMcpAdapter.parseTimeframeDateRange(timeframe);
    if (!range) {
      return true;
    }
    const occurred = new Date(occurredAt).getTime();
    const start = new Date(`${range.start}T00:00:00.000Z`).getTime();
    const end = new Date(`${range.end}T23:59:59.999Z`).getTime();
    if (!Number.isFinite(occurred) || !Number.isFinite(start) || !Number.isFinite(end)) {
      return true;
    }
    return occurred >= start && occurred <= end;
  }

  private static extractNextCursor(chunk: string): string | null {
    const parsed = ClickupMcpAdapter.extractObject(chunk);
    if (!parsed) {
      return null;
    }
    const cursor = parsed.next_cursor;
    return typeof cursor === "string" && cursor.length > 0 ? cursor : null;
  }

  private static summarizeTask(task: Record<string, unknown>): string {
    const pieces: string[] = [];
    const statusRaw = task.status;
    if (typeof statusRaw === "string" && statusRaw.trim().length > 0) {
      pieces.push(`Status: ${statusRaw.trim()}`);
    } else {
      const statusObject = ClickupMcpAdapter.asRecord(statusRaw);
      const statusLabel = statusObject ? ClickupMcpAdapter.asString(statusObject.status) : undefined;
      if (statusLabel) {
        pieces.push(`Status: ${statusLabel}`);
      }
    }

    const hierarchy = ClickupMcpAdapter.asRecord(task.hierarchy);
    if (hierarchy) {
      const project = ClickupMcpAdapter.asRecord(hierarchy.project);
      const category = ClickupMcpAdapter.asRecord(hierarchy.category);
      const subcategory = ClickupMcpAdapter.asRecord(hierarchy.subcategory);
      const locationParts = [
        project ? ClickupMcpAdapter.asString(project.name) : undefined,
        category ? ClickupMcpAdapter.asString(category.name) : undefined,
        subcategory ? ClickupMcpAdapter.asString(subcategory.name) : undefined,
      ].filter((value): value is string => Boolean(value));
      if (locationParts.length > 0) {
        pieces.push(`Location: ${locationParts.join(" / ")}`);
      }
    }

    const assignees = Array.isArray(task.assignees) ? task.assignees : [];
    const assigneeNames = assignees
      .map((entry) => ClickupMcpAdapter.asRecord(entry))
      .filter((entry): entry is Record<string, unknown> => Boolean(entry))
      .map((entry) => ClickupMcpAdapter.asString(entry.username) ?? ClickupMcpAdapter.asString(entry.email))
      .filter((value): value is string => Boolean(value));
    if (assigneeNames.length > 0) {
      pieces.push(`Assignees: ${assigneeNames.join(", ")}`);
    }

    return pieces.join(" | ").slice(0, 1800);
  }

  private static mapTaskObjectToEvidence(
    task: Record<string, unknown>,
    index: number,
    enrichment?: TaskEnrichment,
  ): NormalizedEvidence {
    const idValue = ClickupMcpAdapter.asString(task.id);
    const evidenceId = idValue ? `task-${idValue}` : `task-${index + 1}`;
    const title = ClickupMcpAdapter.asString(task.name) ?? `ClickUp task ${index + 1}`;
    const url = ClickupMcpAdapter.asString(task.url);
    const occurredAt =
      ClickupMcpAdapter.asTimestampIso(task.dateClosed) ??
      ClickupMcpAdapter.asTimestampIso(task.dateDone) ??
      ClickupMcpAdapter.asTimestampIso(task.dateUpdated) ??
      ClickupMcpAdapter.asTimestampIso(task.dateCreated);
    const summaryParts = [ClickupMcpAdapter.summarizeTask(task)];
    if (enrichment?.description) {
      summaryParts.push(`Description: ${ClickupMcpAdapter.limitText(enrichment.description, 700)}`);
    }
    if (enrichment?.comments && enrichment.comments.length > 0) {
      const commentLines = enrichment.comments.map((comment) => {
        const author = comment.author ? `${comment.author}: ` : "";
        const date = comment.occurredAt ? ` (${comment.occurredAt.slice(0, 10)})` : "";
        return `${author}${ClickupMcpAdapter.limitText(comment.text, 240)}${date}`;
      });
      summaryParts.push(`Recent comments: ${commentLines.join(" || ")}`);
    }
    const summary = summaryParts.filter(Boolean).join(" | ").slice(0, 1800) || title;

    return {
      id: evidenceId,
      source: "tasks",
      title,
      summary,
      citation: `TASK-${index + 1}`,
      url,
      occurredAt,
    };
  }

  private static pickIdentifier(candidate: Record<string, unknown>): string | null {
    const user = candidate.user;
    if (user && typeof user === "object" && !Array.isArray(user)) {
      const nestedUser = user as Record<string, unknown>;
      for (const key of ["id", "userid", "userId", "user_id", "username", "name"]) {
        const value = nestedUser[key];
        if (typeof value === "string" && value.length > 0) {
          return value;
        }
      }
    }

    for (const key of ["id", "userId", "user_id", "username", "name", "email"]) {
      const value = candidate[key];
      if (typeof value === "string" && value.length > 0) {
        return value;
      }
    }

    return null;
  }

  private static pickCurrentUserTools(toolNames: string[]): string[] {
    const ranked = toolNames
      .map((toolName) => {
        let score = 0;
        if (/(^|[_-])(current|whoami|me)([_-]|$)/i.test(toolName)) {
          score += 3;
        }
        if (/user|profile|member/i.test(toolName)) {
          score += 2;
        }
        if (/search/i.test(toolName)) {
          score -= 2;
        }
        return { toolName, score };
      })
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score);

    return ranked.map((entry) => entry.toolName);
  }

  private async resolveSearchTool(): Promise<string> {
    if (!this.resolvedSearchToolPromise) {
      this.resolvedSearchToolPromise = (async () => {
        const toolNames = await listMcpTools(this.server);
        if (toolNames.includes(this.configuredSearchTool)) {
          return this.configuredSearchTool;
        }

        const alias = ClickupMcpAdapter.searchToolAliases[this.configuredSearchTool];
        if (alias && toolNames.includes(alias)) {
          return alias;
        }

        const preferredFallback =
          toolNames.find((toolName) => toolName === "clickup_search") ??
          toolNames.find((toolName) => /clickup.*search/i.test(toolName));
        if (preferredFallback) {
          return preferredFallback;
        }

        throw new Error(
          [
            `Configured ClickUp search tool "${this.configuredSearchTool}" was not found.`,
            `Available tools include: ${toolNames.slice(0, 20).join(", ")}${toolNames.length > 20 ? ", ..." : ""}.`,
            'Set `providers.tasks.tools.search` to an existing tool (typically "clickup_search").',
          ].join(" "),
        );
      })();
    }

    return this.resolvedSearchToolPromise;
  }

  private async resolveCurrentUser(fallbackDisplayName: string): Promise<string> {
    if (this.userOverride && this.userOverride.length > 0) {
      return this.userOverride;
    }

    if (!this.resolvedUserPromise) {
      this.resolvedUserPromise = (async () => {
        try {
          const tools = await listMcpTools(this.server);
          const candidates = ClickupMcpAdapter.pickCurrentUserTools(tools);
          for (const candidateTool of candidates) {
            const chunks = await callMcpTool(this.server, candidateTool, {});
            for (const chunk of chunks) {
              const parsed = ClickupMcpAdapter.extractObject(chunk);
              if (parsed) {
                const identifier = ClickupMcpAdapter.pickIdentifier(parsed);
                if (identifier) {
                  return identifier;
                }
              } else if (chunk.trim().length > 0) {
                return chunk.trim();
              }
            }
          }
        } catch {
          // Fallback to display name for compatibility when provider does not expose identity tools.
        }
        return fallbackDisplayName;
      })();
    }

    return this.resolvedUserPromise;
  }

  private async resolveAssigneeIds(userIdentifier: string): Promise<string[]> {
    if (!this.resolvedAssigneeIdsPromise) {
      this.resolvedAssigneeIdsPromise = (async () => {
        try {
          const chunks = await callMcpTool(this.server, "clickup_resolve_assignees", {
            assignees: [userIdentifier],
          });
          for (const chunk of chunks) {
            const parsed = ClickupMcpAdapter.extractObject(chunk);
            if (!parsed) {
              continue;
            }
            if (Array.isArray(parsed.userIds)) {
              const ids = parsed.userIds
                .filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
                .map((entry) => entry.trim())
                .filter((entry) => entry.length > 0);
              if (ids.length > 0) {
                return ids;
              }
            }
          }
        } catch {
          // Keep working even if assignee resolution is unavailable.
        }
        return [];
      })();
    }
    return this.resolvedAssigneeIdsPromise;
  }

  private static extractTaskId(task: Record<string, unknown>): string | null {
    const id = ClickupMcpAdapter.asString(task.id);
    return id && id.length > 0 ? id : null;
  }

  private static async mapWithConcurrency<TInput, TOutput>(
    items: readonly TInput[],
    concurrency: number,
    mapper: (item: TInput, index: number) => Promise<TOutput>,
  ): Promise<TOutput[]> {
    if (items.length === 0) {
      return [];
    }
    const effectiveConcurrency = Math.max(1, Math.min(concurrency, items.length));
    const results: TOutput[] = new Array(items.length);
    let cursor = 0;
    await Promise.all(
      Array.from({ length: effectiveConcurrency }, async () => {
        while (cursor < items.length) {
          const index = cursor;
          cursor += 1;
          results[index] = await mapper(items[index] as TInput, index);
        }
      }),
    );
    return results;
  }

  private static parseTaskDescription(chunks: string[]): string | undefined {
    for (const chunk of chunks) {
      const parsed = ClickupMcpAdapter.extractObject(chunk);
      if (!parsed) {
        continue;
      }
      const description =
        ClickupMcpAdapter.asString(parsed.description) ?? ClickupMcpAdapter.asString(parsed.text_content);
      if (description) {
        return description;
      }
    }
    return undefined;
  }

  private static parseTaskComments(chunks: string[]): CommentSnippet[] {
    const comments: CommentSnippet[] = [];
    for (const chunk of chunks) {
      const parsed = ClickupMcpAdapter.extractObject(chunk);
      if (!parsed || !Array.isArray(parsed.comments)) {
        continue;
      }
      for (const entry of parsed.comments) {
        const comment = ClickupMcpAdapter.asRecord(entry);
        if (!comment) {
          continue;
        }
        const text = ClickupMcpAdapter.asString(comment.comment_text);
        if (!text) {
          continue;
        }
        const user = ClickupMcpAdapter.asRecord(comment.user);
        const author = user
          ? ClickupMcpAdapter.asString(user.username) ?? ClickupMcpAdapter.asString(user.email)
          : undefined;
        const occurredAt = ClickupMcpAdapter.asTimestampIso(comment.date);
        comments.push({ author, text, occurredAt });
      }
    }
    comments.sort((a, b) => {
      const aTs = a.occurredAt ? Date.parse(a.occurredAt) : 0;
      const bTs = b.occurredAt ? Date.parse(b.occurredAt) : 0;
      return bTs - aTs;
    });
    return comments;
  }

  private static buildEnrichmentSummary(enrichment: TaskEnrichment, maxCommentsPerTask: number): string {
    const sections: string[] = [];
    if (enrichment.description) {
      sections.push(`Description: ${ClickupMcpAdapter.limitText(enrichment.description, 700)}`);
    }
    if (enrichment.comments.length > 0) {
      const recentComments = enrichment.comments.slice(0, Math.max(1, maxCommentsPerTask));
      const commentLines = recentComments.map((comment) => {
        const author = comment.author ? `${comment.author}: ` : "";
        const date = comment.occurredAt ? ` (${comment.occurredAt.slice(0, 10)})` : "";
        return `${author}${ClickupMcpAdapter.limitText(comment.text, 240)}${date}`;
      });
      sections.push(`Recent comments: ${commentLines.join(" || ")}`);
    }
    return sections.join(" | ");
  }

  private static attachEnrichmentToEvidence(
    evidence: NormalizedEvidence,
    enrichment: TaskEnrichment,
    maxCommentsPerTask: number,
  ): NormalizedEvidence {
    const enrichmentSummary = ClickupMcpAdapter.buildEnrichmentSummary(enrichment, maxCommentsPerTask);
    if (!enrichmentSummary) {
      return evidence;
    }
    return {
      ...evidence,
      summary: `${evidence.summary} | ${enrichmentSummary}`.slice(0, 1800),
    };
  }

  private static getTaskTags(task: Record<string, unknown>): string[] {
    if (!Array.isArray(task.tags)) {
      return [];
    }
    return task.tags
      .map((tag) => ClickupMcpAdapter.asRecord(tag))
      .filter((tag): tag is Record<string, unknown> => Boolean(tag))
      .map((tag) => ClickupMcpAdapter.asString(tag.name))
      .filter((value): value is string => Boolean(value));
  }

  private static getTaskType(task: Record<string, unknown>): string | undefined {
    return ClickupMcpAdapter.asString(task.taskType) ?? ClickupMcpAdapter.asString(task.type);
  }

  private scoreEnrichmentCandidate(entry: TaskEvidenceEntry): EnrichmentCandidateScore {
    const reasons: string[] = [];
    let score = 0;
    const task = entry.task;
    const title = ClickupMcpAdapter.asString(task.name) ?? entry.evidence.title;
    const status = ClickupMcpAdapter.asString(task.status) ?? "";
    const taskType = ClickupMcpAdapter.getTaskType(task) ?? "";
    const tags = ClickupMcpAdapter.getTaskTags(task);
    const searchable = `${title} ${status} ${taskType} ${tags.join(" ")}`.toLowerCase();

    for (const [keyword, weight] of Object.entries(this.enrichmentScoring.keywordWeights)) {
      const normalizedKeyword = keyword.trim().toLowerCase();
      if (normalizedKeyword.length === 0 || !Number.isFinite(weight)) {
        continue;
      }
      if (searchable.includes(normalizedKeyword)) {
        score += weight;
        reasons.push(`keyword:${normalizedKeyword}(+${weight})`);
      }
    }

    if (status.toLowerCase().includes("done")) {
      score += this.enrichmentScoring.doneBoost;
      reasons.push(`status:done(+${this.enrichmentScoring.doneBoost})`);
    }
    if (status.toLowerCase().includes("closed")) {
      score += this.enrichmentScoring.closedBoost;
      reasons.push(`status:closed(+${this.enrichmentScoring.closedBoost})`);
    }

    const assignees = Array.isArray(task.assignees) ? task.assignees.length : 0;
    if (assignees > 1) {
      score += this.enrichmentScoring.multiAssigneeBoost;
      reasons.push(`multi-assignee(+${this.enrichmentScoring.multiAssigneeBoost})`);
    }

    if (!taskType.toLowerCase().includes("bug")) {
      score += this.enrichmentScoring.nonBugBoost;
      reasons.push(`non-bug(+${this.enrichmentScoring.nonBugBoost})`);
    }

    if (entry.evidence.occurredAt) {
      const occurredAtMs = Date.parse(entry.evidence.occurredAt);
      if (Number.isFinite(occurredAtMs)) {
        const nowMs = Date.now();
        const ageDays = (nowMs - occurredAtMs) / (1000 * 60 * 60 * 24);
        if (ageDays >= 0 && ageDays <= this.enrichmentScoring.recencyWindowDays) {
          const fraction = 1 - ageDays / this.enrichmentScoring.recencyWindowDays;
          const recencyScore = Number((this.enrichmentScoring.recencyBoost * fraction).toFixed(3));
          score += recencyScore;
          reasons.push(`recency(+${recencyScore})`);
        }
      }
    }

    return { score, reasons };
  }

  private rankEntriesForEnrichment(
    entries: readonly TaskEvidenceEntry[],
  ): { selected: TaskEvidenceEntry[]; scoresByTaskId: Map<string, EnrichmentCandidateScore> } {
    const candidates = entries.filter((entry) => Boolean(ClickupMcpAdapter.extractTaskId(entry.task)));
    const scored = candidates.map((entry) => ({
      entry,
      candidateScore: this.scoreEnrichmentCandidate(entry),
    }));

    scored.sort((a, b) => {
      if (b.candidateScore.score !== a.candidateScore.score) {
        return b.candidateScore.score - a.candidateScore.score;
      }
      const aTs = a.entry.evidence.occurredAt ? Date.parse(a.entry.evidence.occurredAt) : 0;
      const bTs = b.entry.evidence.occurredAt ? Date.parse(b.entry.evidence.occurredAt) : 0;
      return bTs - aTs;
    });

    const selected = scored.slice(0, this.maxEnrichedTasks).map((item) => item.entry);
    const selectedTaskIds = new Set(
      selected
        .map((entry) => ClickupMcpAdapter.extractTaskId(entry.task))
        .filter((taskId): taskId is string => typeof taskId === "string" && taskId.length > 0),
    );
    const scoresByTaskId = new Map<string, EnrichmentCandidateScore>();
    for (const item of scored) {
      const taskId = ClickupMcpAdapter.extractTaskId(item.entry.task);
      if (!taskId || !selectedTaskIds.has(taskId)) {
        continue;
      }
      scoresByTaskId.set(taskId, item.candidateScore);
    }
    return { selected, scoresByTaskId };
  }

  private async enrichTasks(tasks: readonly Record<string, unknown>[]): Promise<Map<string, TaskEnrichment>> {
    const uniqueTaskIds = [
      ...new Set(
        tasks
          .map((task) => ClickupMcpAdapter.extractTaskId(task))
          .filter((taskId): taskId is string => typeof taskId === "string" && taskId.length > 0),
      ),
    ];
    const pairs = await ClickupMcpAdapter.mapWithConcurrency(uniqueTaskIds, this.enrichmentConcurrency, async (taskId) => {
      try {
        const [taskChunks, commentChunks] = await Promise.all([
          callMcpTool(this.server, "clickup_get_task", { task_id: taskId, detail_level: "detailed" }),
          callMcpTool(this.server, "clickup_get_task_comments", { task_id: taskId }),
        ]);
        const description = ClickupMcpAdapter.parseTaskDescription(taskChunks);
        const comments = ClickupMcpAdapter.parseTaskComments(commentChunks);
        return [taskId, { description, comments }] as const satisfies readonly [string, TaskEnrichment];
      } catch {
        return [taskId, { description: undefined, comments: [] }] as const satisfies readonly [string, TaskEnrichment];
      }
    });
    return new Map(pairs);
  }

  private async callSearchTool(
    searchTool: string,
    request: ProviderQueryRequest,
    userIdentifier: string,
    query: string,
  ): Promise<string[]> {
    if (searchTool !== "clickup_search") {
      return callMcpTool(this.server, searchTool, {
        user: userIdentifier,
        timeframe: request.timeframe,
        query,
      });
    }

    const assigneeIds = await this.resolveAssigneeIds(userIdentifier);
    const filters: Record<string, unknown> = {
      asset_types: ["task"],
    };
    if (assigneeIds.length > 0) {
      filters.assignees = assigneeIds;
    }

    const chunks: string[] = [];
    const maxPages = 25;
    let cursor: string | undefined;
    for (let page = 0; page < maxPages; page += 1) {
      const pageResponse = await callMcpTool(this.server, searchTool, {
        keywords: query,
        filters,
        count: 100,
        sort: [{ field: "updated_at", direction: "desc" }],
        ...(cursor ? { cursor } : {}),
      });
      chunks.push(...pageResponse);
      const nextCursor = pageResponse
        .map((chunk) => ClickupMcpAdapter.extractNextCursor(chunk))
        .find((value): value is string => Boolean(value));
      if (!nextCursor) {
        break;
      }
      cursor = nextCursor;
    }
    return chunks;
  }

  public async getCompletedTasks(request: ProviderQueryRequest): Promise<NormalizedEvidence[]> {
    const fallbackChunks: string[] = [];
    const rawTaskObjects: Record<string, unknown>[] = [];
    const debugQueries: Array<{ query: string; chunks: string[]; extractedTaskObjects: number; hadMcpError: boolean }> = [];
    const user = await this.resolveCurrentUser(request.subject.displayName);
    const searchTool = await this.resolveSearchTool();

    const searchQueries =
      searchTool === "clickup_search" ? [...new Set(["", ...request.queries])] : [...request.queries];

    for (const query of searchQueries) {
      const response = await this.callSearchTool(searchTool, request, user, query);
      let extractedTaskObjects = 0;
      let hadMcpError = false;
      for (const chunk of response) {
        if (ClickupMcpAdapter.isMcpErrorChunk(chunk)) {
          hadMcpError = true;
          fallbackChunks.push(chunk);
          continue;
        }
        const parsedTasks = ClickupMcpAdapter.extractTaskObjectsFromChunk(chunk);
        if (parsedTasks.length > 0) {
          rawTaskObjects.push(...parsedTasks);
          extractedTaskObjects += parsedTasks.length;
          continue;
        }
        fallbackChunks.push(chunk);
      }
      debugQueries.push({
        query: query.length > 0 ? query : "<all-assigned-tasks>",
        chunks: response,
        extractedTaskObjects,
        hadMcpError,
      });
    }

    const parsedTaskEntries: TaskEvidenceEntry[] = rawTaskObjects.map((task, index) => {
      return {
        task,
        evidence: ClickupMcpAdapter.mapTaskObjectToEvidence(task, index),
      };
    });
    const fallbackEvidence = normalizeTextChunks("tasks", fallbackChunks, "TASK");
    const deduplicated = new Map<string, TaskEvidenceEntry>();
    for (const entry of parsedTaskEntries) {
      const evidence = entry.evidence;
      const dedupeKey = evidence.url ?? `${evidence.title}::${evidence.summary}`;
      if (!deduplicated.has(dedupeKey)) {
        deduplicated.set(dedupeKey, entry);
      }
    }
    for (const evidence of fallbackEvidence) {
      const dedupeKey = evidence.url ?? `${evidence.title}::${evidence.summary}`;
      if (!deduplicated.has(dedupeKey)) {
        deduplicated.set(dedupeKey, { evidence, task: {} });
      }
    }

    const filteredEntries = [...deduplicated.values()].filter((entry) =>
      ClickupMcpAdapter.withinDateRange(entry.evidence.occurredAt, request.timeframe),
    );

    let enrichmentByTaskId = new Map<string, TaskEnrichment>();
    let selectedTaskScores = new Map<string, EnrichmentCandidateScore>();
    if (this.enrichTaskDetails) {
      const ranking = this.rankEntriesForEnrichment(filteredEntries);
      selectedTaskScores = ranking.scoresByTaskId;
      const taskCandidates = ranking.selected.map((entry) => entry.task);
      enrichmentByTaskId = await this.enrichTasks(taskCandidates);
    }

    const filteredByTimeframe = filteredEntries.map((entry) => {
      const taskId = ClickupMcpAdapter.extractTaskId(entry.task);
      const enrichment = taskId ? enrichmentByTaskId.get(taskId) : undefined;
      if (!enrichment) {
        return entry.evidence;
      }
      return ClickupMcpAdapter.attachEnrichmentToEvidence(entry.evidence, enrichment, this.maxCommentsPerTask);
    });

    if (this.debugOutputPath) {
      const debugPayload = {
        provider: this.name,
        generatedAt: new Date().toISOString(),
        configuredSearchTool: this.configuredSearchTool,
        resolvedSearchTool: searchTool,
        user,
        timeframe: request.timeframe,
        queryCount: request.queries.length,
        normalizedTaskCount: filteredByTimeframe.length,
        rawTaskObjectCount: rawTaskObjects.length,
        fallbackChunkCount: fallbackChunks.length,
        enrichmentEnabled: this.enrichTaskDetails,
        enrichmentLimit: this.maxEnrichedTasks,
        enrichmentConcurrency: this.enrichmentConcurrency,
        maxCommentsPerTask: this.maxCommentsPerTask,
        enrichedTaskCount: enrichmentByTaskId.size,
        enrichmentScoring: this.enrichmentScoring,
        selectedForEnrichment: [...selectedTaskScores.entries()].map(([taskId, data]) => ({
          taskId,
          score: data.score,
          reasons: data.reasons,
        })),
        queries: debugQueries,
        rawTaskObjects,
        normalizedTasks: filteredByTimeframe,
      };
      await mkdir(dirname(this.debugOutputPath), { recursive: true });
      await writeFile(this.debugOutputPath, JSON.stringify(debugPayload, null, 2), "utf8");
    }

    return filteredByTimeframe;
  }
}
