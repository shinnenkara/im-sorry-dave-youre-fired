export type ProviderSlot = "code" | "tasks" | "comms";
export type ProviderType = "github-cli" | "clickup-mcp" | "slack-mcp";
export type ReadinessCheckId = "github-cli" | "clickup-mcp" | "slack-mcp" | "gemini";

export interface ProviderOptionMeta {
  slot: ProviderSlot;
  type: ProviderType;
  label: string;
  defaultSelected?: boolean;
  readinessCheck: ReadinessCheckId;
  description: string;
  evidenceLooksFor: string[];
  setupHelp: string;
}

export interface TimeframeOptionMeta {
  value: "last_3_months" | "last_6_months" | "last_12_months";
  label: string;
}

export const timeframeOptions: TimeframeOptionMeta[] = [
  { value: "last_3_months", label: "Last 3 months" },
  { value: "last_6_months", label: "Last 6 months" },
  { value: "last_12_months", label: "Last 12 months" },
];

export const providerWizardMeta: ProviderOptionMeta[] = [
  {
    slot: "code",
    type: "github-cli",
    label: "GitHub",
    defaultSelected: true,
    readinessCheck: "github-cli",
    description: "Collects pull request and code review activity with GitHub CLI.",
    evidenceLooksFor: [
      "Merged pull requests authored by the selected GitHub user",
      "Pull requests reviewed by the selected GitHub user",
      "Repository-scoped results when repositories are configured",
    ],
    setupHelp: "Run `gh auth login` (and verify with `gh auth status`) before using GitHub provider.",
  },
  {
    slot: "tasks",
    type: "clickup-mcp",
    label: "ClickUp",
    defaultSelected: true,
    readinessCheck: "clickup-mcp",
    description: "Collects tasks and comments through ClickUp MCP.",
    evidenceLooksFor: [
      "Tasks assigned to the selected ClickUp user",
      "Task comments and task detail snippets relevant to review topics",
      "Timeframe-filtered task activity",
    ],
    setupHelp: "Configure ClickUp MCP access first. See README provider notes for setup details.",
  },
  {
    slot: "comms",
    type: "slack-mcp",
    label: "Slack",
    readinessCheck: "slack-mcp",
    description: "Slack provider is currently unavailable in the interactive setup.",
    evidenceLooksFor: ["Not available yet in interactive setup."],
    setupHelp: "Use YAML config for Slack today. Interactive support is coming soon.",
  },
];

export const questionInputExample =
  "Example: Focus on architectural impact, cross-team collaboration, and mentoring outcomes.";
