import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { McpServerConfig } from "../config/types.js";
import { normalizeTextChunks } from "../normalize/evidence.js";

import type { ICommProvider, NormalizedEvidence, ProviderQueryRequest } from "./contracts.js";
import { callMcpTool, listMcpTools, McpToolError } from "./mcpClient.js";

export interface SlackMcpProviderOptions {
  server: McpServerConfig;
  searchTool: string;
  debugOutputPath?: string;
  expectedWorkspace?: string;
  expectedUserId?: string;
  expectedUserEmail?: string;
  priorityChannels?: string[];
  enableReactionReads?: boolean;
  maxReactionMessages?: number;
}

interface ParsedTimeframeRange {
  start: string;
  end: string;
}

interface SearchDebugEntry {
  mode: "planned-query" | "dm-probe" | "priority-probe";
  query: string;
  timeframeSlice?: string;
  attemptedQueries?: string[];
  chunks: string[];
  parsedTextCount: number;
  noResults: boolean;
  extractedConversations: number;
}

interface McpCallDebugEntry {
  stage: string;
  tool: string;
  argsPreview: string;
  durationMs: number;
  ok: boolean;
  error?: string;
}

interface ThreadRef {
  channelId: string;
  threadTs: string;
}

interface MentionProfile {
  userId: string;
  username?: string;
  title?: string;
}

interface ChannelCandidate {
  channelId: string;
  name: string;
  permalink?: string;
  channelType?: string;
}

interface ChannelScanDebugEntry {
  channelId: string;
  channelName: string;
  chunks: string[];
  relevanceScore: number;
  extractedConversations: number;
  hadNoMessages: boolean;
}

interface ConversationCandidate {
  title: string;
  summary: string;
  url?: string;
  occurredAt?: string;
  score: number;
}

interface SlackProfileSnapshot {
  userId?: string;
  username?: string;
  realName?: string;
  title?: string;
  email?: string;
  organizationName?: string;
}

export class SlackMcpAdapter implements ICommProvider {
  public readonly name = "slack-mcp";
  private static readonly docsUrl = "https://docs.slack.dev/ai/slack-mcp-server/developing";
  private static readonly mcpRemoteStaticOauthDocsUrl =
    "https://github.com/geelen/mcp-remote?tab=readme-ov-file#static-oauth-client-information";
  private static readonly searchToolAliases: Record<string, string> = {
    slack_search_messages: "search_messages",
    search_messages: "slack_search_public_and_private",
    slack_search_all: "slack_search_public_and_private",
  };
  private readonly server: McpServerConfig;
  private readonly configuredSearchTool: string;
  private readonly debugOutputPath?: string;
  private readonly expectedWorkspace?: string;
  private readonly expectedUserId?: string;
  private readonly expectedUserEmail?: string;
  private readonly priorityChannels: string[];
  private readonly enableReactionReads: boolean;
  private readonly maxReactionMessages: number;
  private static readonly maxFinalEvidence = 24;
  private static readonly maxChannelScans = 25;
  private static readonly maxChannelThreadReads = 10;
  private static readonly maxMentionProfiles = 40;
  private static readonly maxTimeSlices = 8;
  private static readonly defaultTimeSliceDays = 30;
  private static readonly threadHydrationEnabled = (process.env.REVIEW_ENABLE_THREAD_HYDRATION ?? "0") === "1";
  private static readonly runtimeDebugEnabled =
    (process.env.REVIEW_RUNTIME_DEBUG ?? process.env.REVIEW_DEBUG ?? "1").toLowerCase() !== "0";
  private hasOpenedSetupLink = false;
  private resolvedUserPromise?: Promise<string>;
  private resolvedSearchToolPromise?: Promise<string>;

  public constructor(options: SlackMcpProviderOptions) {
    this.server = options.server;
    this.configuredSearchTool = options.searchTool;
    this.debugOutputPath = options.debugOutputPath;
    this.expectedWorkspace = options.expectedWorkspace;
    this.expectedUserId = options.expectedUserId;
    this.expectedUserEmail = options.expectedUserEmail;
    this.priorityChannels = (options.priorityChannels ?? []).map((item) => item.toLowerCase());
    this.enableReactionReads = options.enableReactionReads === true;
    this.maxReactionMessages = Math.max(1, options.maxReactionMessages ?? 30);
  }

  private logRuntime(message: string): void {
    if (!SlackMcpAdapter.runtimeDebugEnabled) {
      return;
    }
    // Emergency runtime diagnostics for long-running Slack MCP collection.
    console.log(`[slack-runtime] ${message}`);
  }

  private async writeDebugOutput(payload: Record<string, unknown>): Promise<void> {
    if (!this.debugOutputPath) {
      return;
    }
    await mkdir(dirname(this.debugOutputPath), { recursive: true });
    await writeFile(this.debugOutputPath, JSON.stringify(payload, null, 2), "utf8");
  }

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

  private static pickIdentifier(candidate: Record<string, unknown>): string | null {
    const user = candidate.user;
    if (user && typeof user === "object" && !Array.isArray(user)) {
      const nestedUser = user as Record<string, unknown>;
      const id = nestedUser.id;
      if (typeof id === "string" && id.length > 0) {
        return id;
      }

      const profile = nestedUser.profile;
      if (profile && typeof profile === "object" && !Array.isArray(profile)) {
        const displayName = (profile as Record<string, unknown>).display_name;
        if (typeof displayName === "string" && displayName.length > 0) {
          return displayName;
        }
      }
    }

    for (const key of ["id", "userId", "user_id", "username", "name"]) {
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
        if (/user|profile/i.test(toolName)) {
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

  private static compactWhitespace(value: string): string {
    return value.replace(/\s+/g, " ").trim();
  }

  private static extractResultText(raw: string): string {
    const parsed = SlackMcpAdapter.extractObject(raw);
    if (!parsed) {
      return raw;
    }

    for (const key of ["results", "messages", "text", "result"]) {
      const value = parsed[key];
      if (typeof value === "string") {
        return value;
      }
    }
    return raw;
  }

  private static containsNoResults(text: string): boolean {
    return /\bno results found\b/i.test(text);
  }

  private static extractMarkdownUrl(text: string): string | undefined {
    const markdownMatch = text.match(/\[[^\]]+\]\((https?:\/\/[^)\s]+)\)/i);
    if (markdownMatch?.[1]) {
      return markdownMatch[1];
    }
    const rawMatch = text.match(/https?:\/\/\S+/i);
    return rawMatch?.[0];
  }

  private static parseTimeframeDateRange(timeframe: string): ParsedTimeframeRange | undefined {
    const match = timeframe.match(/(\d{4}-\d{2}-\d{2})\s+to\s+(\d{4}-\d{2}-\d{2})/i);
    if (!match?.[1] || !match[2]) {
      return undefined;
    }
    return { start: match[1], end: match[2] };
  }

  private static parseDateOnly(value: string): Date | undefined {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    if (Number.isNaN(parsed.getTime())) {
      return undefined;
    }
    return parsed;
  }

  private static formatDateOnly(value: Date): string {
    return value.toISOString().slice(0, 10);
  }

  private static splitTimeframeIntoSlices(range?: ParsedTimeframeRange): ParsedTimeframeRange[] {
    if (!range) {
      return [];
    }
    const startDate = SlackMcpAdapter.parseDateOnly(range.start);
    const endDate = SlackMcpAdapter.parseDateOnly(range.end);
    if (!startDate || !endDate || startDate > endDate) {
      return [range];
    }
    const slices: ParsedTimeframeRange[] = [];
    let cursor = new Date(startDate.getTime());
    while (cursor <= endDate && slices.length < SlackMcpAdapter.maxTimeSlices) {
      const sliceEnd = new Date(
        Math.min(
          endDate.getTime(),
          cursor.getTime() + (SlackMcpAdapter.defaultTimeSliceDays - 1) * 24 * 60 * 60 * 1000,
        ),
      );
      slices.push({
        start: SlackMcpAdapter.formatDateOnly(cursor),
        end: SlackMcpAdapter.formatDateOnly(sliceEnd),
      });
      cursor = new Date(sliceEnd.getTime() + 24 * 60 * 60 * 1000);
    }
    if (slices.length === 0) {
      return [range];
    }
    return slices;
  }

  private static formatSliceLabel(range?: ParsedTimeframeRange): string | undefined {
    if (!range) {
      return undefined;
    }
    return `${range.start}..${range.end}`;
  }

  private static extractUserId(value: string): string | undefined {
    const directMatch = value.trim().match(/^U[A-Z0-9]{6,}$/);
    if (directMatch?.[0]) {
      return directMatch[0];
    }
    const mentionMatch = value.match(/<@([UW][A-Z0-9]{6,})>/);
    if (mentionMatch?.[1]) {
      return mentionMatch[1];
    }
    return undefined;
  }

  private static extractChannelIdFromPermalink(permalink: string): string | undefined {
    const match = permalink.match(/\/archives\/([A-Z0-9]+)/);
    return match?.[1];
  }

  private static splitResultBlocks(text: string): string[] {
    const sections = text
      .split(/\n###\s+Result\s+\d+\s+of\s+\d+\n/i)
      .map((section) => section.trim())
      .filter((section) => section.length > 0);
    return sections.length > 1 ? sections.slice(1) : [];
  }

  private static parseChannelCandidates(text: string): ChannelCandidate[] {
    const blocks = SlackMcpAdapter.splitResultBlocks(text);
    const channels: ChannelCandidate[] = [];
    for (const block of blocks) {
      const name = block.match(/Name:\s*([^\n]+)/i)?.[1]?.trim();
      const permalink = block.match(/Permalink:\s*\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/i)?.[1]?.trim();
      const channelType = block.match(/Channel Type:\s*([^\n]+)/i)?.[1]?.trim();
      const channelId = permalink ? SlackMcpAdapter.extractChannelIdFromPermalink(permalink) : undefined;
      if (!channelId || !name) {
        continue;
      }
      channels.push({ channelId, name, permalink, channelType });
    }
    return channels;
  }

  private static getDisplayNameTerms(displayName: string): string[] {
    const base = displayName
      .toLowerCase()
      .split(/[^a-z0-9]+/i)
      .map((part) => part.trim())
      .filter((part) => part.length >= 4);
    return [...new Set([displayName.toLowerCase(), ...base])];
  }

  private static scoreTextRelevance(text: string, displayName: string, userId?: string): number {
    const normalized = text.toLowerCase();
    let score = 0;
    for (const term of SlackMcpAdapter.getDisplayNameTerms(displayName)) {
      if (normalized.includes(term)) {
        score += 1;
      }
    }
    if (userId && text.includes(`<@${userId}>`)) {
      score += 3;
    }
    return score;
  }

  private static buildConversationFromText(
    sourceLabel: string,
    rawText: string,
    scoreBoost: number,
    displayName: string,
    userId?: string,
  ): ConversationCandidate | null {
    const text = rawText.trim();
    if (text.length === 0 || SlackMcpAdapter.containsNoResults(text)) {
      return null;
    }
    const compact = SlackMcpAdapter.compactWhitespace(text);
    if (compact.length < 30) {
      return null;
    }
    const titleLine = text
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0 && !line.startsWith("#"));
    const title = titleLine ? `${sourceLabel}: ${titleLine.slice(0, 110)}` : sourceLabel;
    const relevanceScore = SlackMcpAdapter.scoreTextRelevance(text, displayName, userId);
    return {
      title,
      summary: compact.slice(0, 1800),
      url: SlackMcpAdapter.extractMarkdownUrl(text),
      score: scoreBoost + relevanceScore,
    };
  }

  private static parseThreadRefs(channelText: string): Array<{ channelId: string; threadTs: string }> {
    const refs: Array<{ channelId: string; threadTs: string }> = [];
    const matches = channelText.matchAll(/\/archives\/([A-Z0-9]+)\/p(\d{16})/g);
    for (const match of matches) {
      const channelId = match[1];
      const compactTs = match[2];
      if (!channelId || !compactTs) {
        continue;
      }
      const seconds = compactTs.slice(0, 10);
      const micros = compactTs.slice(10);
      if (seconds.length !== 10 || micros.length !== 6) {
        continue;
      }
      refs.push({ channelId, threadTs: `${seconds}.${micros}` });
    }
    return refs;
  }

  private static normalizeChannelKey(value: string): string {
    return value.trim().toLowerCase().replace(/^#/, "");
  }

  private static buildPriorityQueries(subject: string, channels: string[], range?: ParsedTimeframeRange): string[] {
    if (channels.length === 0) {
      return [];
    }
    const subjectBit = `"${subject}"`;
    return channels
      .map((channel) => channel.trim())
      .filter((channel) => channel.length > 0)
      .map((channel) => SlackMcpAdapter.formatDateScopedQuery(`${subjectBit} in:#${channel.replace(/^#/, "")}`, range));
  }

  private static extractMentionedUserIds(text: string): string[] {
    const ids = new Set<string>();
    for (const match of text.matchAll(/<@([UW][A-Z0-9]{6,})>/g)) {
      if (match[1]) {
        ids.add(match[1]);
      }
    }
    return [...ids];
  }

  private static parseMessageRefs(text: string): Array<{ channelId: string; messageTs: string }> {
    const refs: Array<{ channelId: string; messageTs: string }> = [];
    for (const match of text.matchAll(/\/archives\/([A-Z0-9]+)\/p(\d{16})/g)) {
      const channelId = match[1];
      const compactTs = match[2];
      if (!channelId || !compactTs) {
        continue;
      }
      const seconds = compactTs.slice(0, 10);
      const micros = compactTs.slice(10);
      if (seconds.length === 10 && micros.length === 6) {
        refs.push({ channelId, messageTs: `${seconds}.${micros}` });
      }
    }
    return refs;
  }

  private static formatDateScopedQuery(baseQuery: string, range?: ParsedTimeframeRange): string {
    if (!range) {
      return baseQuery.trim();
    }
    return `${baseQuery.trim()} after:${range.start} before:${range.end}`.trim();
  }

  private static parseProfileSnapshot(rawText: string): SlackProfileSnapshot {
    const snapshot: SlackProfileSnapshot = {};
    for (const rawLine of rawText.split("\n")) {
      const line = rawLine.trim();
      if (line.length === 0) {
        continue;
      }
      const match = line.match(/^([^:]+):\s*(.*)$/);
      if (!match?.[1]) {
        continue;
      }
      const key = match[1].trim().toLowerCase();
      const value = (match[2] ?? "").trim();
      if (value.length === 0) {
        continue;
      }
      if (key === "user id") {
        snapshot.userId = value;
      } else if (key === "username") {
        snapshot.username = value;
      } else if (key === "real name") {
        snapshot.realName = value;
      } else if (key === "title") {
        snapshot.title = value;
      } else if (key === "email") {
        snapshot.email = value;
      } else if (key === "organization name") {
        snapshot.organizationName = value;
      }
    }
    return snapshot;
  }

  private static parseProfileSnapshotFromObject(value: Record<string, unknown>): SlackProfileSnapshot {
    const snapshot: SlackProfileSnapshot = {};
    const userNode = value.user;
    const user = userNode && typeof userNode === "object" && !Array.isArray(userNode) ? userNode : value;
    if (!user || typeof user !== "object" || Array.isArray(user)) {
      return snapshot;
    }
    const record = user as Record<string, unknown>;
    if (typeof record.id === "string" && record.id.length > 0) {
      snapshot.userId = record.id;
    }
    if (typeof record.name === "string" && record.name.length > 0) {
      snapshot.username = record.name;
    }
    const profileNode = record.profile;
    if (profileNode && typeof profileNode === "object" && !Array.isArray(profileNode)) {
      const profile = profileNode as Record<string, unknown>;
      if (typeof profile.email === "string" && profile.email.length > 0) {
        snapshot.email = profile.email;
      }
      if (typeof profile.title === "string" && profile.title.length > 0) {
        snapshot.title = profile.title;
      }
      if (typeof profile.real_name === "string" && profile.real_name.length > 0) {
        snapshot.realName = profile.real_name;
      }
      if (typeof profile.display_name === "string" && profile.display_name.length > 0 && !snapshot.username) {
        snapshot.username = profile.display_name;
      }
    }
    return snapshot;
  }

  private static normalizeForCompare(value: string): string {
    return value.trim().toLowerCase();
  }

  private static normalizeWorkspace(value: string): string {
    return SlackMcpAdapter.normalizeForCompare(value)
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .replace(/\/.*$/, "")
      .replace(/\.slack\.com$/, "");
  }

  private async readCurrentProfileSnapshot(callDebugEntries?: McpCallDebugEntry[]): Promise<SlackProfileSnapshot | undefined> {
    try {
      const profileChunks = await this.callToolWithFallbackArgs(
        "slack_read_user_profile",
        [{}, { user: "me" }, { user_id: "me" }],
        "profile:read-current",
        callDebugEntries,
      );
      for (const chunk of profileChunks) {
        const parsedObject = SlackMcpAdapter.extractObject(chunk);
        if (parsedObject) {
          const fromObject = SlackMcpAdapter.parseProfileSnapshotFromObject(parsedObject);
          if (fromObject.userId || fromObject.email || fromObject.organizationName || fromObject.username || fromObject.title) {
            return fromObject;
          }
        }
        const text = SlackMcpAdapter.extractResultText(chunk);
        const parsed = SlackMcpAdapter.parseProfileSnapshot(text);
        if (parsed.userId || parsed.email || parsed.organizationName || parsed.username || parsed.title) {
          return parsed;
        }
      }
    } catch {
      // Continue without profile guard when profile tool is unavailable.
    }
    return undefined;
  }

  private assertExpectedIdentity(profile: SlackProfileSnapshot | undefined): void {
    if (!this.expectedWorkspace && !this.expectedUserId && !this.expectedUserEmail) {
      return;
    }

    const mismatches: string[] = [];
    if (this.expectedWorkspace) {
      const actualWorkspace = profile?.organizationName;
      if (!actualWorkspace) {
        mismatches.push(`expected workspace "${this.expectedWorkspace}", but workspace is unavailable from Slack profile`);
      } else if (
        SlackMcpAdapter.normalizeWorkspace(actualWorkspace) !== SlackMcpAdapter.normalizeWorkspace(this.expectedWorkspace)
      ) {
        mismatches.push(`expected workspace "${this.expectedWorkspace}", got "${actualWorkspace}"`);
      }
    }

    if (this.expectedUserId) {
      const actualUserId = profile?.userId;
      if (!actualUserId) {
        mismatches.push(`expected user id "${this.expectedUserId}", but user id is unavailable from Slack profile`);
      } else if (actualUserId.toUpperCase() !== this.expectedUserId.toUpperCase()) {
        mismatches.push(`expected user id "${this.expectedUserId}", got "${actualUserId}"`);
      }
    }

    if (this.expectedUserEmail) {
      const actualEmail = profile?.email;
      if (!actualEmail) {
        mismatches.push(`expected user email "${this.expectedUserEmail}", but email is unavailable from Slack profile`);
      } else if (SlackMcpAdapter.normalizeForCompare(actualEmail) !== SlackMcpAdapter.normalizeForCompare(this.expectedUserEmail)) {
        mismatches.push(`expected user email "${this.expectedUserEmail}", got "${actualEmail}"`);
      }
    }

    if (mismatches.length > 0) {
      throw new Error(`Slack MCP identity mismatch: ${mismatches.join("; ")}.`);
    }
  }

  private static buildPlannedQueryCandidates(
    rawQuery: string,
    displayName: string,
    range?: ParsedTimeframeRange,
  ): string[] {
    const compact = rawQuery.replace(/\s+/g, " ").trim();
    const replacedParticipant = compact.replace(/participant:\s*"[^"]+"|participant:\S+/gi, `"${displayName}"`);
    const withoutDateRange = replacedParticipant.replace(/\bdate:\d{4}-\d{2}-\d{2}\.\.\d{4}-\d{2}-\d{2}\b/gi, "").trim();
    const flattened = withoutDateRange
      .replace(/[()]/g, " ")
      .replace(/\bOR\b/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
    const focusQuery = `"${displayName}"`;
    return [
      SlackMcpAdapter.formatDateScopedQuery(compact, range),
      SlackMcpAdapter.formatDateScopedQuery(withoutDateRange, range),
      SlackMcpAdapter.formatDateScopedQuery(flattened, range),
      SlackMcpAdapter.formatDateScopedQuery(focusQuery, range),
    ].filter((value, index, all) => value.length > 0 && all.indexOf(value) === index);
  }

  private static isEffectivelyEmptyChannelText(text: string): boolean {
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      return true;
    }
    if (/^Channel:\s*#[^\n]+\([A-Z0-9]+\)$/i.test(trimmed)) {
      return true;
    }
    return /\bthere are no more messages available\b/i.test(trimmed) && trimmed.split("\n").length <= 3;
  }

  private async resolveSearchTool(): Promise<string> {
    if (!this.resolvedSearchToolPromise) {
      this.resolvedSearchToolPromise = (async () => {
        try {
          const toolNames = await listMcpTools(this.server);
          if (toolNames.includes(this.configuredSearchTool)) {
            return this.configuredSearchTool;
          }

          const alias = SlackMcpAdapter.searchToolAliases[this.configuredSearchTool];
          if (alias && toolNames.includes(alias)) {
            return alias;
          }

          const preferredFallback =
            toolNames.find((toolName) => toolName === "slack_search_public_and_private") ??
            toolNames.find((toolName) => toolName === "slack_search_public") ??
            toolNames.find((toolName) => toolName === "search_messages");
          if (preferredFallback) {
            return preferredFallback;
          }

          const fallback = toolNames.find(
            (toolName) =>
              /(search.*messages?|messages?.*search|slack_search_public_and_private|slack_search_public)/i.test(
                toolName,
              ),
          );
          if (fallback) {
            return fallback;
          }
        } catch {
          // Keep configured tool when MCP tool listing is unavailable (for example, before OAuth completes).
        }
        return this.configuredSearchTool;
      })();
    }
    return this.resolvedSearchToolPromise;
  }

  private async resolveCurrentUser(fallbackDisplayName: string): Promise<string> {
    if (!this.resolvedUserPromise) {
      this.resolvedUserPromise = (async () => {
        try {
          const tools = await listMcpTools(this.server);
          const candidates = SlackMcpAdapter.pickCurrentUserTools(tools);
          for (const candidateTool of candidates) {
            const chunks = await callMcpTool(this.server, candidateTool, {});
            for (const chunk of chunks) {
              const parsed = SlackMcpAdapter.extractObject(chunk);
              if (parsed) {
                const identifier = SlackMcpAdapter.pickIdentifier(parsed);
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

  private static formatSlackMcpAuthError(
    originalError: unknown,
    server: McpServerConfig,
    openedSetupGuide: boolean,
    setupUrl: string,
  ): Error {
    const details = originalError instanceof Error ? originalError.message : String(originalError);
    const normalized = details.toLowerCase();
    const usesMcpRemote = server.command === "npx" && (server.args ?? []).some((part) => part.includes("mcp-remote"));
    const hasStaticOauthClient =
      (server.args ?? []).includes("--static-oauth-client-info") ||
      (server.args ?? []).includes("--static-oauth-client-metadata");
    const likelyDcrIncompatibility = usesMcpRemote && !hasStaticOauthClient;
    const looksLikeAuthOrApprovalIssue =
      normalized.includes("connection closed") ||
      normalized.includes("unauthorized") ||
      normalized.includes("forbidden") ||
      normalized.includes("oauth") ||
      normalized.includes("not approved") ||
      normalized.includes("mcp error -32000") ||
      normalized.includes("slack mcp server access");
    if (!looksLikeAuthOrApprovalIssue) {
      return originalError instanceof Error ? originalError : new Error(details);
    }

    const appAssistantMatch = details.match(/https:\/\/api\.slack\.com\/apps\/[A-Z0-9]+\/app-assistant/i);
    if (appAssistantMatch) {
      const appAssistantUrl = appAssistantMatch[0];
      return new Error(
        [
          "Slack OAuth succeeded, but this Slack app is not enabled for Slack MCP server access yet.",
          openedSetupGuide
            ? "Opening Slack app setup page in your browser now."
            : "Open the Slack app setup page in your browser.",
          `Enable MCP for the app here: ${appAssistantUrl}`,
          `Original error: ${details}`,
        ].join(" "),
      );
    }

    if (likelyDcrIncompatibility) {
      return new Error(
        [
          "Slack MCP failed through mcp-remote. Slack's auth server does not support dynamic client registration, so plain `npx mcp-remote https://mcp.slack.com/mcp` usually cannot complete OAuth.",
          openedSetupGuide
            ? "Opening Slack setup guide in your browser now."
            : "Open the Slack setup guide in your browser.",
          "Use an MCP client with native Slack MCP integration, or configure mcp-remote with static OAuth client info/metadata.",
          `Slack setup guide: ${setupUrl}`,
          `mcp-remote static OAuth docs: ${SlackMcpAdapter.mcpRemoteStaticOauthDocsUrl}`,
          `Original error: ${details}`,
        ].join(" "),
      );
    }

    return new Error(
      [
        "Slack MCP connection failed. Complete Slack OAuth in your MCP client and make sure your workspace admin approved the Slack MCP app.",
        openedSetupGuide ? "Opening Slack setup guide in your browser now." : "Open the setup guide in your browser.",
        `Open setup guide: ${setupUrl}`,
        `Original error: ${details}`,
      ].join(" "),
    );
  }

  private static isArgShapeError(error: unknown): boolean {
    const details = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
    return (
      details.includes("invalid") ||
      details.includes("schema") ||
      details.includes("required") ||
      details.includes("unexpected") ||
      details.includes("failed to run tool")
    );
  }

  private static toArgsPreview(args: Record<string, unknown>): string {
    try {
      const serialized = JSON.stringify(args);
      return serialized.length > 240 ? `${serialized.slice(0, 240)}...` : serialized;
    } catch {
      return "[unserializable args]";
    }
  }

  private buildSearchArgCandidates(
    searchTool: string,
    request: ProviderQueryRequest,
    user: string,
    query: string,
  ): Array<Record<string, unknown>> {
    if (/^slack_search_/i.test(searchTool)) {
      return [
        { query },
        { search_query: query },
        { text: query },
        { keywords: query },
      ];
    }

    return [{ user, timeframe: request.timeframe, query }];
  }

  private async callSearchWithFallbackArgs(
    searchTool: string,
    request: ProviderQueryRequest,
    user: string,
    query: string,
    stage: string,
    callDebugEntries?: McpCallDebugEntry[],
  ): Promise<string[]> {
    const candidates = this.buildSearchArgCandidates(searchTool, request, user, query);
    let lastError: unknown;
    this.logRuntime(
      `stage=${stage} tool=${searchTool} argShapes=${candidates.length} query="${query.slice(0, 140)}${query.length > 140 ? "..." : ""}"`,
    );
    for (const args of candidates) {
      const startedAt = Date.now();
      try {
        this.logRuntime(`stage=${stage} tool=${searchTool} call:start args=${SlackMcpAdapter.toArgsPreview(args)}`);
        const chunks = await callMcpTool(this.server, searchTool, args);
        this.logRuntime(
          `stage=${stage} tool=${searchTool} call:ok durationMs=${Date.now() - startedAt} chunks=${chunks.length}`,
        );
        callDebugEntries?.push({
          stage,
          tool: searchTool,
          argsPreview: SlackMcpAdapter.toArgsPreview(args),
          durationMs: Date.now() - startedAt,
          ok: true,
        });
        return chunks;
      } catch (error) {
        lastError = error;
        this.logRuntime(
          `stage=${stage} tool=${searchTool} call:error durationMs=${Date.now() - startedAt} error="${
            error instanceof Error ? error.message : String(error)
          }"`,
        );
        callDebugEntries?.push({
          stage,
          tool: searchTool,
          argsPreview: SlackMcpAdapter.toArgsPreview(args),
          durationMs: Date.now() - startedAt,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
        if (error instanceof McpToolError && SlackMcpAdapter.isArgShapeError(error)) {
          continue;
        }
        throw error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async callToolWithFallbackArgs(
    toolName: string,
    candidates: Array<Record<string, unknown>>,
    stage: string,
    callDebugEntries?: McpCallDebugEntry[],
  ): Promise<string[]> {
    let lastError: unknown;
    this.logRuntime(`stage=${stage} tool=${toolName} argShapes=${candidates.length}`);
    for (const args of candidates) {
      const startedAt = Date.now();
      try {
        this.logRuntime(`stage=${stage} tool=${toolName} call:start args=${SlackMcpAdapter.toArgsPreview(args)}`);
        const chunks = await callMcpTool(this.server, toolName, args);
        this.logRuntime(`stage=${stage} tool=${toolName} call:ok durationMs=${Date.now() - startedAt} chunks=${chunks.length}`);
        callDebugEntries?.push({
          stage,
          tool: toolName,
          argsPreview: SlackMcpAdapter.toArgsPreview(args),
          durationMs: Date.now() - startedAt,
          ok: true,
        });
        return chunks;
      } catch (error) {
        lastError = error;
        this.logRuntime(
          `stage=${stage} tool=${toolName} call:error durationMs=${Date.now() - startedAt} error="${
            error instanceof Error ? error.message : String(error)
          }"`,
        );
        callDebugEntries?.push({
          stage,
          tool: toolName,
          argsPreview: SlackMcpAdapter.toArgsPreview(args),
          durationMs: Date.now() - startedAt,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
        if (error instanceof McpToolError && SlackMcpAdapter.isArgShapeError(error)) {
          continue;
        }
        throw error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async resolveSubjectUserId(
    subject: ProviderQueryRequest["subject"],
    resolvedUser: string,
    profileSnapshot?: SlackProfileSnapshot,
    callDebugEntries?: McpCallDebugEntry[],
  ): Promise<string | undefined> {
    const configuredId = SlackMcpAdapter.extractUserId(subject.slackUserId ?? "");
    if (configuredId) {
      return configuredId;
    }

    if (subject.email && profileSnapshot?.email) {
      if (SlackMcpAdapter.normalizeForCompare(subject.email) === SlackMcpAdapter.normalizeForCompare(profileSnapshot.email)) {
        const ownId = SlackMcpAdapter.extractUserId(profileSnapshot.userId ?? "");
        if (ownId) {
          return ownId;
        }
      }
    }

    const direct = SlackMcpAdapter.extractUserId(resolvedUser);
    if (direct) {
      return direct;
    }

    if (subject.email) {
      try {
        const chunks = await this.callToolWithFallbackArgs("slack_search_users", [
          { query: subject.email },
          { text: subject.email },
        ], "identity:search-by-email", callDebugEntries);
        for (const chunk of chunks) {
          const parsedObject = SlackMcpAdapter.extractObject(chunk);
          if (parsedObject) {
            const profile = SlackMcpAdapter.parseProfileSnapshotFromObject(parsedObject);
            const idFromProfile = SlackMcpAdapter.extractUserId(profile.userId ?? "");
            if (
              idFromProfile &&
              profile.email &&
              SlackMcpAdapter.normalizeForCompare(profile.email) === SlackMcpAdapter.normalizeForCompare(subject.email)
            ) {
              return idFromProfile;
            }
          }
          const resultText = SlackMcpAdapter.extractResultText(chunk);
          const parsed = SlackMcpAdapter.extractUserId(resultText);
          if (parsed) {
            return parsed;
          }
        }
      } catch {
        // Continue to display-name lookup fallback.
      }
    }

    try {
      const chunks = await this.callToolWithFallbackArgs("slack_search_users", [
        { query: subject.displayName },
        { text: subject.displayName },
      ], "identity:search-by-display-name", callDebugEntries);
      for (const chunk of chunks) {
        const resultText = SlackMcpAdapter.extractResultText(chunk);
        const parsed = SlackMcpAdapter.extractUserId(resultText);
        if (parsed) {
          return parsed;
        }
      }
    } catch {
      // Not all workspaces/tools allow user search; continue without strict user id.
    }
    return undefined;
  }

  private async loadMentionProfiles(
    userIds: string[],
    callDebugEntries?: McpCallDebugEntry[],
  ): Promise<MentionProfile[]> {
    const selected = userIds.slice(0, SlackMcpAdapter.maxMentionProfiles);
    this.logRuntime(`mentions:read-profile planned=${selected.length} (requested=${userIds.length})`);
    const profiles: MentionProfile[] = [];
    for (const userId of selected) {
      try {
        const chunks = await this.callToolWithFallbackArgs("slack_read_user_profile", [
          { user_id: userId },
          { user: userId },
        ], "mentions:read-profile", callDebugEntries);
        let profile: SlackProfileSnapshot | undefined;
        for (const chunk of chunks) {
          const parsedObject = SlackMcpAdapter.extractObject(chunk);
          if (parsedObject) {
            const fromObject = SlackMcpAdapter.parseProfileSnapshotFromObject(parsedObject);
            if (fromObject.userId || fromObject.username || fromObject.title) {
              profile = fromObject;
              break;
            }
          }
          const text = SlackMcpAdapter.extractResultText(chunk);
          const fromText = SlackMcpAdapter.parseProfileSnapshot(text);
          if (fromText.userId || fromText.username || fromText.title) {
            profile = fromText;
            break;
          }
        }
        if (profile) {
          profiles.push({
            userId: profile.userId ?? userId,
            username: profile.username ?? profile.realName,
            title: profile.title,
          });
        }
      } catch {
        // Mention profile enrichment is optional.
      }
    }
    return profiles;
  }

  private async loadOptionalReactions(
    items: ConversationCandidate[],
    callDebugEntries?: McpCallDebugEntry[],
  ): Promise<Record<string, string>> {
    if (!this.enableReactionReads) {
      this.logRuntime("reactions:read-message disabled");
      return {};
    }
    const compactReactions: Record<string, string> = {};
    const messageRefs = new Map<string, { channelId: string; messageTs: string }>();
    for (const item of items) {
      for (const ref of SlackMcpAdapter.parseMessageRefs(item.summary)) {
        messageRefs.set(`${ref.channelId}:${ref.messageTs}`, ref);
      }
    }
    let processed = 0;
    this.logRuntime(`reactions:read-message planned=${Math.min(messageRefs.size, this.maxReactionMessages)} refs=${messageRefs.size}`);
    for (const ref of messageRefs.values()) {
      if (processed >= this.maxReactionMessages) {
        break;
      }
      try {
        const chunks = await this.callToolWithFallbackArgs("slack_read_message", [
          { channel_id: ref.channelId, message_ts: ref.messageTs },
          { channel: ref.channelId, ts: ref.messageTs },
          { channel: ref.channelId, message_ts: ref.messageTs },
        ], "reactions:read-message", callDebugEntries);
        const text = chunks.map((chunk) => SlackMcpAdapter.extractResultText(chunk)).join(" ");
        const reactionLine = text
          .split("\n")
          .map((line) => line.trim())
          .find((line) => /^reactions?:/i.test(line));
        if (reactionLine) {
          compactReactions[`${ref.channelId}:${ref.messageTs}`] = reactionLine.slice(0, 240);
        }
      } catch {
        // Reaction reads are optional and depend on tool availability.
      }
      processed += 1;
    }
    this.logRuntime(`reactions:read-message completed processed=${processed} reactionsFound=${Object.keys(compactReactions).length}`);
    return compactReactions;
  }

  private maybeOpenLink(url: string): boolean {
    if (this.hasOpenedSetupLink) {
      return false;
    }
    if (process.env.CI === "true" || process.env.CI === "1") {
      return false;
    }
    if (process.env.REVIEW_DISABLE_BROWSER_OPEN === "1") {
      return false;
    }

    const platform = process.platform;
    let command: string;
    let args: string[];

    if (platform === "darwin") {
      command = "open";
      args = [url];
    } else if (platform === "win32") {
      command = "cmd";
      args = ["/c", "start", "", url];
    } else {
      command = "xdg-open";
      args = [url];
    }

    try {
      const child = spawn(command, args, {
        detached: true,
        stdio: "ignore",
      });
      child.unref();
      this.hasOpenedSetupLink = true;
      return true;
    } catch {
      // Best-effort UX helper only.
      return false;
    }
  }

  public async getConversations(request: ProviderQueryRequest): Promise<NormalizedEvidence[]> {
    const conversationCandidates: ConversationCandidate[] = [];
    const searchDebugEntries: SearchDebugEntry[] = [];
    const channelScanDebugEntries: ChannelScanDebugEntry[] = [];
    const mcpCallDebugEntries: McpCallDebugEntry[] = [];
    const mentionIds = new Set<string>();
    const pendingThreadRefs = new Map<string, ThreadRef>();
    let user: string | undefined;
    let userId: string | undefined;
    let profileSnapshot: SlackProfileSnapshot | undefined;
    let searchTool: string | undefined;
    let discoveredChannels: ChannelCandidate[] = [];
    let effectiveSlices: Array<ParsedTimeframeRange | undefined> = [undefined];
    let scannedChannels = 0;
    let threadsRead = 0;
    try {
      this.logRuntime(`start timeframe="${request.timeframe}" plannedQueries=${request.queries.length}`);
      user = await this.resolveCurrentUser(request.subject.displayName);
      searchTool = await this.resolveSearchTool();
      profileSnapshot = await this.readCurrentProfileSnapshot(mcpCallDebugEntries);
      this.assertExpectedIdentity(profileSnapshot);
      userId = await this.resolveSubjectUserId(request.subject, user, profileSnapshot, mcpCallDebugEntries);
      if (!userId && request.subject.slackUserId) {
        userId = SlackMcpAdapter.extractUserId(request.subject.slackUserId);
      }
      const timeframeRange = SlackMcpAdapter.parseTimeframeDateRange(request.timeframe);
      const timeframeSlices = SlackMcpAdapter.splitTimeframeIntoSlices(timeframeRange);
      effectiveSlices = timeframeSlices.length > 0 ? timeframeSlices : [undefined];
      this.logRuntime(`timeSlices count=${effectiveSlices.length} values=${effectiveSlices.map((slice) => SlackMcpAdapter.formatSliceLabel(slice) ?? "full").join(",")}`);
      const queryUser = userId ? `<@${userId}>` : user;
      this.logRuntime(`threadHydration enabled=${SlackMcpAdapter.threadHydrationEnabled}`);

      // Stage 1: planned search queries with time-sliced windows.
      for (const query of request.queries) {
        for (const slice of effectiveSlices) {
          const candidateQueries = SlackMcpAdapter.buildPlannedQueryCandidates(
            query,
            request.subject.displayName,
            slice,
          );
          let selectedQuery = candidateQueries[0] ?? query;
          let response: string[] = [];
          let parsedTexts: string[] = [];
          let extracted: ConversationCandidate[] = [];
          for (const queryCandidate of candidateQueries) {
            const currentResponse = await this.callSearchWithFallbackArgs(
              searchTool,
              request,
              queryUser,
              queryCandidate,
              "search:planned-query",
              mcpCallDebugEntries,
            );
            const currentTexts = currentResponse.map((chunk) => SlackMcpAdapter.extractResultText(chunk));
            for (const text of currentTexts) {
              for (const mention of SlackMcpAdapter.extractMentionedUserIds(text)) {
                mentionIds.add(mention);
              }
              if (SlackMcpAdapter.threadHydrationEnabled) {
                for (const ref of SlackMcpAdapter.parseThreadRefs(text)) {
                  pendingThreadRefs.set(`${ref.channelId}:${ref.threadTs}`, ref);
                }
              }
            }
            const currentExtracted = currentTexts
              .map((text) =>
                SlackMcpAdapter.buildConversationFromText(
                  "Slack search",
                  text,
                  3,
                  request.subject.displayName,
                  userId,
                ),
              )
              .filter((item): item is ConversationCandidate => Boolean(item));
            selectedQuery = queryCandidate;
            response = currentResponse;
            parsedTexts = currentTexts;
            extracted = currentExtracted;
            if (currentExtracted.length > 0 || !currentTexts.every((text) => SlackMcpAdapter.containsNoResults(text))) {
              break;
            }
          }
          conversationCandidates.push(...extracted);
          searchDebugEntries.push({
            mode: "planned-query",
            query: selectedQuery,
            timeframeSlice: SlackMcpAdapter.formatSliceLabel(slice),
            attemptedQueries: candidateQueries,
            chunks: response,
            parsedTextCount: parsedTexts.length,
            noResults: parsedTexts.every((text) => SlackMcpAdapter.containsNoResults(text)),
            extractedConversations: extracted.length,
          });
        }
      }

      // Stage 2: DM/private probes to include direct conversations.
      const dmProbeQueries = [
        userId ? `<@${userId}> in:dm` : undefined,
        userId ? `from:<@${userId}>` : undefined,
        request.subject.email ? `"${request.subject.email}" in:dm` : undefined,
        `"${request.subject.displayName}" in:dm`,
      ]
        .filter((value, index, all): value is string => Boolean(value) && all.indexOf(value) === index);
      this.logRuntime(`search:planned total=${request.queries.length * effectiveSlices.length} windows=${effectiveSlices.length}`);
      this.logRuntime(`search:dm-probe total=${dmProbeQueries.length * effectiveSlices.length}`);

      for (const slice of effectiveSlices) {
        for (const query of dmProbeQueries) {
          const scopedQuery = SlackMcpAdapter.formatDateScopedQuery(query, slice);
          const response = await this.callSearchWithFallbackArgs(
            searchTool,
            request,
            queryUser,
            scopedQuery,
            "search:dm-probe",
            mcpCallDebugEntries,
          );
          const parsedTexts = response.map((chunk) => SlackMcpAdapter.extractResultText(chunk));
          for (const text of parsedTexts) {
            for (const mention of SlackMcpAdapter.extractMentionedUserIds(text)) {
              mentionIds.add(mention);
            }
            if (SlackMcpAdapter.threadHydrationEnabled) {
              for (const ref of SlackMcpAdapter.parseThreadRefs(text)) {
                pendingThreadRefs.set(`${ref.channelId}:${ref.threadTs}`, ref);
              }
            }
          }
          const extracted = parsedTexts
            .map((text) =>
              SlackMcpAdapter.buildConversationFromText(
                "Slack DM/private search",
                text,
                4,
                request.subject.displayName,
                userId,
              ),
            )
            .filter((item): item is ConversationCandidate => Boolean(item));
          conversationCandidates.push(...extracted);
          searchDebugEntries.push({
            mode: "dm-probe",
            query: scopedQuery,
            timeframeSlice: SlackMcpAdapter.formatSliceLabel(slice),
            chunks: response,
            parsedTextCount: parsedTexts.length,
            noResults: parsedTexts.every((text) => SlackMcpAdapter.containsNoResults(text)),
            extractedConversations: extracted.length,
          });
        }
      }

      // Stage 2b: priority channel probes (planning/scoring hints only).
      for (const slice of effectiveSlices) {
        const priorityQueries = SlackMcpAdapter.buildPriorityQueries(
          request.subject.displayName,
          this.priorityChannels,
          slice,
        );
        for (const query of priorityQueries) {
          const response = await this.callSearchWithFallbackArgs(
            searchTool,
            request,
            queryUser,
            query,
            "search:priority-probe",
            mcpCallDebugEntries,
          );
          const parsedTexts = response.map((chunk) => SlackMcpAdapter.extractResultText(chunk));
          for (const text of parsedTexts) {
            for (const mention of SlackMcpAdapter.extractMentionedUserIds(text)) {
              mentionIds.add(mention);
            }
            if (SlackMcpAdapter.threadHydrationEnabled) {
              for (const ref of SlackMcpAdapter.parseThreadRefs(text)) {
                pendingThreadRefs.set(`${ref.channelId}:${ref.threadTs}`, ref);
              }
            }
          }
          const extracted = parsedTexts
            .map((text) =>
              SlackMcpAdapter.buildConversationFromText(
                "Slack priority-channel search",
                text,
                5,
                request.subject.displayName,
                userId,
              ),
            )
            .filter((item): item is ConversationCandidate => Boolean(item));
          conversationCandidates.push(...extracted);
          searchDebugEntries.push({
            mode: "priority-probe",
            query,
            timeframeSlice: SlackMcpAdapter.formatSliceLabel(slice),
            chunks: response,
            parsedTextCount: parsedTexts.length,
            noResults: parsedTexts.every((text) => SlackMcpAdapter.containsNoResults(text)),
            extractedConversations: extracted.length,
          });
        }
      }
      this.logRuntime(`search:priority-probe total=${this.priorityChannels.length * effectiveSlices.length} channels=${this.priorityChannels.length}`);

      // Stage 3: discover channels and read only channels that mention the subject.
      try {
        const channelDiscoveryResponse = await this.callToolWithFallbackArgs(
          "slack_search_channels",
          [{ query: "" }, {}],
          "channels:discover",
          mcpCallDebugEntries,
        );
        const parsedChannelTexts = channelDiscoveryResponse.map((chunk) => SlackMcpAdapter.extractResultText(chunk));
        discoveredChannels = [
          ...new Map(
            parsedChannelTexts
              .flatMap((text) => SlackMcpAdapter.parseChannelCandidates(text))
              .map((candidate) => [candidate.channelId, candidate]),
          ).values(),
        ];
      } catch {
        discoveredChannels = [];
      }
      this.logRuntime(`channels:discover found=${discoveredChannels.length} scanLimit=${SlackMcpAdapter.maxChannelScans}`);

      const priorityChannelSet = new Set(this.priorityChannels.map((channel) => SlackMcpAdapter.normalizeChannelKey(channel)));
      discoveredChannels = [...discoveredChannels].sort((left, right) => {
        const leftPriority = priorityChannelSet.has(SlackMcpAdapter.normalizeChannelKey(left.name)) ? 1 : 0;
        const rightPriority = priorityChannelSet.has(SlackMcpAdapter.normalizeChannelKey(right.name)) ? 1 : 0;
        if (leftPriority !== rightPriority) {
          return rightPriority - leftPriority;
        }
        return left.name.localeCompare(right.name);
      });

      if (SlackMcpAdapter.threadHydrationEnabled) {
        for (const threadRef of pendingThreadRefs.values()) {
          if (threadsRead >= SlackMcpAdapter.maxChannelThreadReads) {
            break;
          }
          try {
            const threadResponse = await this.callToolWithFallbackArgs(
              "slack_read_thread",
              [
                { channel_id: threadRef.channelId, thread_ts: threadRef.threadTs },
                { channel: threadRef.channelId, thread_ts: threadRef.threadTs },
              ],
              "threads:from-search",
              mcpCallDebugEntries,
            );
            const threadText = threadResponse.map((chunk) => SlackMcpAdapter.extractResultText(chunk)).join("\n\n");
            for (const mention of SlackMcpAdapter.extractMentionedUserIds(threadText)) {
              mentionIds.add(mention);
            }
            const threadConversation = SlackMcpAdapter.buildConversationFromText(
              "Thread from search hit",
              threadText,
              6,
              request.subject.displayName,
              userId,
            );
            if (threadConversation) {
              conversationCandidates.push(threadConversation);
            }
            threadsRead += 1;
          } catch {
            // Thread read may not be available in every channel context.
          }
        }
      }
      this.logRuntime(`threads:from-search attempted=${pendingThreadRefs.size} read=${threadsRead} limit=${SlackMcpAdapter.maxChannelThreadReads}`);

      for (const channel of discoveredChannels.slice(0, SlackMcpAdapter.maxChannelScans)) {
        scannedChannels += 1;
        const readResponse = await this.callToolWithFallbackArgs(
          "slack_read_channel",
          [
            { channel_id: channel.channelId },
            { channel: channel.channelId },
          ],
          "channels:read",
          mcpCallDebugEntries,
        );
        const texts = readResponse.map((chunk) => SlackMcpAdapter.extractResultText(chunk));
        const joined = texts.join("\n\n");
        for (const mention of SlackMcpAdapter.extractMentionedUserIds(joined)) {
          mentionIds.add(mention);
        }
        if (SlackMcpAdapter.threadHydrationEnabled) {
          for (const ref of SlackMcpAdapter.parseThreadRefs(joined)) {
            pendingThreadRefs.set(`${ref.channelId}:${ref.threadTs}`, ref);
          }
        }
        const priorityBoost = priorityChannelSet.has(SlackMcpAdapter.normalizeChannelKey(channel.name)) ? 2 : 0;
        const relevanceScore = SlackMcpAdapter.scoreTextRelevance(joined, request.subject.displayName, userId) + priorityBoost;
        const hadNoMessages = SlackMcpAdapter.isEffectivelyEmptyChannelText(joined);
        const extracted: ConversationCandidate[] = [];
        if (relevanceScore > 0 && !hadNoMessages) {
          const channelConversation = SlackMcpAdapter.buildConversationFromText(
            `Channel ${channel.name}`,
            joined,
            5,
            request.subject.displayName,
            userId,
          );
          if (channelConversation) {
            extracted.push(channelConversation);
            conversationCandidates.push(channelConversation);
          }

          if (SlackMcpAdapter.threadHydrationEnabled) {
            const threadRefs = SlackMcpAdapter.parseThreadRefs(joined).slice(0, SlackMcpAdapter.maxChannelThreadReads - threadsRead);
            for (const threadRef of threadRefs) {
              if (threadsRead >= SlackMcpAdapter.maxChannelThreadReads) {
                break;
              }
              try {
                const threadResponse = await this.callToolWithFallbackArgs(
                  "slack_read_thread",
                  [
                    { channel_id: threadRef.channelId, thread_ts: threadRef.threadTs },
                    { channel: threadRef.channelId, thread_ts: threadRef.threadTs },
                  ],
                  "threads:from-channel-read",
                  mcpCallDebugEntries,
                );
                const threadText = threadResponse.map((chunk) => SlackMcpAdapter.extractResultText(chunk)).join("\n\n");
                const threadConversation = SlackMcpAdapter.buildConversationFromText(
                  `Thread in ${channel.name}`,
                  threadText,
                  6,
                  request.subject.displayName,
                  userId,
                );
                if (threadConversation) {
                  conversationCandidates.push(threadConversation);
                }
                threadsRead += 1;
              } catch {
                // Thread read may not be supported on all returned URLs/contexts; continue.
              }
            }
          }
        }
        channelScanDebugEntries.push({
          channelId: channel.channelId,
          channelName: channel.name,
          chunks: readResponse,
          relevanceScore,
          extractedConversations: extracted.length,
          hadNoMessages,
        });
      }
      this.logRuntime(`channels:read scanned=${scannedChannels} threadsRead=${threadsRead}`);

      const deduped = new Map<string, ConversationCandidate>();
      for (const item of conversationCandidates) {
        if (SlackMcpAdapter.containsNoResults(item.summary)) {
          continue;
        }
        const key = item.url ?? item.summary.slice(0, 220);
        const existing = deduped.get(key);
        if (!existing || item.score > existing.score) {
          deduped.set(key, item);
        }
      }

      const selected = [...deduped.values()]
        .sort((a, b) => b.score - a.score)
        .slice(0, SlackMcpAdapter.maxFinalEvidence);
      const mentionProfiles = await this.loadMentionProfiles(
        [...mentionIds].filter((id) => id !== userId),
        mcpCallDebugEntries,
      );
      const mentionProfileMap = new Map<string, MentionProfile>(mentionProfiles.map((profile) => [profile.userId, profile]));
      const compactReactions = await this.loadOptionalReactions(selected, mcpCallDebugEntries);
      const mcpFailedCalls = mcpCallDebugEntries.filter((entry) => !entry.ok);
      const mcpSlowestCalls = [...mcpCallDebugEntries]
        .sort((a, b) => b.durationMs - a.durationMs)
        .slice(0, 20);
      const normalizedConversations: NormalizedEvidence[] = selected.map((item, index) => {
        const tags: string[] = [];
        for (const mentionId of SlackMcpAdapter.extractMentionedUserIds(item.summary)) {
          tags.push(`mention:${mentionId}`);
          const mentionProfile = mentionProfileMap.get(mentionId);
          if (mentionProfile?.title) {
            tags.push(`title:${mentionProfile.title}`);
          }
        }
        return {
          id: `comms-${index + 1}`,
          source: "comms",
          title: item.title,
          summary: item.summary,
          citation: `COMM-${index + 1}`,
          url: item.url,
          occurredAt: item.occurredAt,
          tags: tags.length > 0 ? [...new Set(tags)].slice(0, 8) : undefined,
        };
      });

      await this.writeDebugOutput({
        provider: this.name,
        generatedAt: new Date().toISOString(),
        configuredSearchTool: this.configuredSearchTool,
        resolvedSearchTool: searchTool,
        user,
        userId,
        profile: profileSnapshot,
        subject: {
          displayName: request.subject.displayName,
          email: request.subject.email,
          slackUserId: request.subject.slackUserId,
        },
        timeframe: request.timeframe,
        timeframeSlices: effectiveSlices.map((slice) => SlackMcpAdapter.formatSliceLabel(slice)).filter(Boolean),
        queryCount: searchDebugEntries.length,
        rawChunkCount: searchDebugEntries.reduce((sum, entry) => sum + entry.chunks.length, 0),
        priorityChannels: this.priorityChannels,
        mentionsFound: mentionIds.size,
        mentionProfiles,
        reactionCollection: {
          enabled: this.enableReactionReads,
          maxMessages: this.maxReactionMessages,
          reactionsFound: Object.keys(compactReactions).length,
          reactions: compactReactions,
        },
        threadHydration: {
          enabled: SlackMcpAdapter.threadHydrationEnabled,
          maxThreadReads: SlackMcpAdapter.maxChannelThreadReads,
          threadRefsDiscovered: pendingThreadRefs.size,
        },
        mcpCalls: mcpCallDebugEntries,
        mcpCallFailures: mcpFailedCalls,
        mcpSlowestCalls,
        channelsDiscovered: discoveredChannels.length,
        channelsScanned: scannedChannels,
        threadsRead,
        candidateConversationCount: conversationCandidates.length,
        normalizedConversationCount: normalizedConversations.length,
        queries: searchDebugEntries,
        channelReads: channelScanDebugEntries,
        normalizedConversations,
      });
      this.logRuntime(
        `done normalized=${normalizedConversations.length} mcpCalls=${mcpCallDebugEntries.length} failures=${mcpFailedCalls.length}`,
      );
      return normalizedConversations;
    } catch (error) {
      let thrownError: unknown = error;
      if (error instanceof McpToolError) {
        const details = error.message;
        const appAssistantMatch = details.match(/https:\/\/api\.slack\.com\/apps\/[A-Z0-9]+\/app-assistant/i);
        const setupUrl = appAssistantMatch?.[0] ?? SlackMcpAdapter.docsUrl;
        const openedSetupGuide = this.maybeOpenLink(setupUrl);
        thrownError = SlackMcpAdapter.formatSlackMcpAuthError(error, this.server, openedSetupGuide, setupUrl);
      }
      await this.writeDebugOutput({
        provider: this.name,
        generatedAt: new Date().toISOString(),
        configuredSearchTool: this.configuredSearchTool,
        resolvedSearchTool: searchTool,
        user,
        userId,
        profile: profileSnapshot,
        subject: {
          displayName: request.subject.displayName,
          email: request.subject.email,
          slackUserId: request.subject.slackUserId,
        },
        timeframe: request.timeframe,
        timeframeSlices: effectiveSlices.map((slice) => SlackMcpAdapter.formatSliceLabel(slice)).filter(Boolean),
        queryCount: searchDebugEntries.length,
        rawChunkCount: searchDebugEntries.reduce((sum, entry) => sum + entry.chunks.length, 0),
        priorityChannels: this.priorityChannels,
        mentionsFound: mentionIds.size,
        threadHydration: {
          enabled: SlackMcpAdapter.threadHydrationEnabled,
          maxThreadReads: SlackMcpAdapter.maxChannelThreadReads,
          threadRefsDiscovered: pendingThreadRefs.size,
        },
        mcpCalls: mcpCallDebugEntries,
        mcpCallFailures: mcpCallDebugEntries.filter((entry) => !entry.ok),
        mcpSlowestCalls: [...mcpCallDebugEntries].sort((a, b) => b.durationMs - a.durationMs).slice(0, 20),
        channelsDiscovered: discoveredChannels.length,
        channelsScanned: scannedChannels,
        threadsRead,
        normalizedConversationCount: 0,
        queries: searchDebugEntries,
        channelReads: channelScanDebugEntries,
        error: thrownError instanceof Error ? thrownError.message : String(thrownError),
      });
      this.logRuntime(`failed error="${thrownError instanceof Error ? thrownError.message : String(thrownError)}" mcpCalls=${mcpCallDebugEntries.length}`);
      throw thrownError;
    }
  }
}
