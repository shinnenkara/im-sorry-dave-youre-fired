export interface ReviewSubjectConfig {
  displayName: string;
  githubUsername?: string;
}

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface TaskProviderConfig {
  enabled: boolean;
  type: "clickup-mcp";
  server: string;
  user?: string;
  debugOutputPath?: string;
  enrichment?: {
    enabled?: boolean;
    maxTasks?: number;
    concurrency?: number;
    maxCommentsPerTask?: number;
    scoring?: {
      keywordWeights?: Record<string, number>;
      doneBoost?: number;
      closedBoost?: number;
      multiAssigneeBoost?: number;
      nonBugBoost?: number;
      recencyBoost?: number;
      recencyWindowDays?: number;
    };
  };
  tools: {
    search: string;
  };
}

export interface CommProviderConfig {
  enabled: boolean;
  type: "slack-mcp";
  server: string;
  debugOutputPath?: string;
  expectedWorkspace?: string;
  expectedUserId?: string;
  expectedUserEmail?: string;
  tools: {
    search: string;
  };
}

export interface CodeProviderConfig {
  enabled: boolean;
  type: "github-cli";
  repo?: string | string[];
  debugOutputPath?: string;
  prLimit: number;
}

export interface ReviewModelConfig {
  fast: string;
  pro: string;
}

/** Supported in YAML as a string key, e.g. `last_3_months`, or as `{ preset: last_3_months }`. */
export type TimeframePresetId = "last_3_months" | "last_6_months" | "last_12_months";

/** Raw `timeframe` field after YAML/JSON parse (before resolution to concrete dates). */
export type TimeframeYaml =
  | string
  | { preset: TimeframePresetId }
  | { preset: "custom"; start: string; end: string };

/** Normalized window: human label, filename slug, and text for provider/MCP search tools. */
export interface ResolvedTimeframe {
  label: string;
  slug: string;
  providerScope: string;
}

export interface ReviewConfig {
  appName?: string;
  timeframe: ResolvedTimeframe;
  subject: ReviewSubjectConfig;
  reviewQuestions: string[];
  outDir: string;
  maxContextChars: number;
  models: ReviewModelConfig;
  mcpServers: Record<string, McpServerConfig>;
  providers: {
    tasks?: TaskProviderConfig;
    comms?: CommProviderConfig;
    code?: CodeProviderConfig;
  };
}
