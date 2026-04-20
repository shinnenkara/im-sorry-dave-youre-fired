import { resolve } from "node:path";

import type {
  CodeProviderConfig,
  CommProviderConfig,
  ReviewConfig,
  TaskProviderConfig,
} from "../config/types.js";

import { ClickupMcpAdapter } from "./clickupMcp.js";
import type { ICodeProvider, ICommProvider, ITaskProvider } from "./contracts.js";
import { GitHubCliAdapter } from "./githubCli.js";
import { McpServerResolver } from "./mcpServerResolver.js";
import { SlackMcpAdapter } from "./slackMcp.js";

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

function normalizePriorityChannels(value?: string | string[]): string[] | undefined {
  if (!value) {
    return undefined;
  }
  const channels = (Array.isArray(value) ? value : [value])
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .map((item) => item.replace(/^#/, ""));
  if (channels.length === 0) {
    return undefined;
  }
  return [...new Set(channels)];
}

class DebugArtifactPaths {
  private readonly outDir: string;
  private readonly subjectSlug: string;
  private readonly timeframeSlug: string;

  public constructor(config: ReviewConfig) {
    this.outDir = config.outDir;
    this.subjectSlug = slugify(config.subject.displayName);
    this.timeframeSlug = config.timeframe.slug;
  }

  public tasks(): string {
    return resolve(this.outDir, `clickup_tasks_${this.subjectSlug}_${this.timeframeSlug}.json`);
  }

  public comms(): string {
    return resolve(this.outDir, `slack_messages_${this.subjectSlug}_${this.timeframeSlug}.json`);
  }

  public code(): string {
    return resolve(this.outDir, `github_activity_${this.subjectSlug}_${this.timeframeSlug}.json`);
  }
}

export interface ResolvedProviders {
  taskProvider?: ITaskProvider;
  commProvider?: ICommProvider;
  codeProvider?: ICodeProvider;
}

export class ProviderFactory {
  private readonly config: ReviewConfig;
  private readonly mcpServers: McpServerResolver;
  private readonly debugPaths: DebugArtifactPaths;

  public constructor(config: ReviewConfig) {
    this.config = config;
    this.mcpServers = new McpServerResolver(config.mcpServers);
    this.debugPaths = new DebugArtifactPaths(config);
  }

  public build(): ResolvedProviders {
    return {
      taskProvider: this.buildTaskProvider(this.config.providers.tasks),
      commProvider: this.buildCommProvider(this.config.providers.comms),
      codeProvider: this.buildCodeProvider(this.config.providers.code),
    };
  }

  private buildTaskProvider(config?: TaskProviderConfig): ITaskProvider | undefined {
    if (!config || !config.enabled) {
      return undefined;
    }

    switch (config.type) {
      case "clickup-mcp":
        return new ClickupMcpAdapter({
          server: this.mcpServers.require(config.server),
          searchTool: config.tools.search,
          userOverride: config.user,
          debugOutputPath: config.debugOutputPath ?? this.debugPaths.tasks(),
          enrichTaskDetails: config.enrichment?.enabled,
          maxEnrichedTasks: config.enrichment?.maxTasks,
          enrichmentConcurrency: config.enrichment?.concurrency,
          maxCommentsPerTask: config.enrichment?.maxCommentsPerTask,
          enrichmentScoring: config.enrichment?.scoring,
        });
    }
  }

  private buildCommProvider(config?: CommProviderConfig): ICommProvider | undefined {
    if (!config || !config.enabled) {
      return undefined;
    }

    switch (config.type) {
      case "slack-mcp":
        return new SlackMcpAdapter({
          server: this.mcpServers.require(config.server),
          searchTool: config.tools.search,
          debugOutputPath: config.debugOutputPath ?? this.debugPaths.comms(),
          expectedWorkspace: config.expectedWorkspace,
          expectedUserId: config.expectedUserId,
          expectedUserEmail: config.expectedUserEmail,
          priorityChannels: normalizePriorityChannels(config.priorityChannels),
          enableReactionReads: config.reactions?.enabled,
          maxReactionMessages: config.reactions?.maxMessages,
        });
    }
  }

  private buildCodeProvider(config?: CodeProviderConfig): ICodeProvider | undefined {
    if (!config || !config.enabled) {
      return undefined;
    }

    switch (config.type) {
      case "github-cli":
        return new GitHubCliAdapter({
          org: config.org,
          repo: config.repo,
          debugOutputPath: config.debugOutputPath ?? this.debugPaths.code(),
          prLimit: config.prLimit,
        });
    }
  }
}
