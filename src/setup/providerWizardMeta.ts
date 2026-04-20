export type ProviderSlot = "code" | "tasks" | "comms";
export type ProviderType = "github-cli" | "clickup-mcp" | "slack-mcp";
export type ReadinessCheckId = "github-cli" | "clickup-mcp" | "slack-mcp" | "gemini" | "anthropic";

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
      "Organization-scoped results when a GitHub org is configured",
      "Preferred repositories are ranked first when a repo list is configured",
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
    description: "Collects direct and channel communication evidence via Slack MCP.",
    evidenceLooksFor: [
      "Relevant direct messages for the selected user in the timeframe",
      "Public/private channel discussions mentioning the selected user",
      "Discussion context and collaboration signals related to review topics",
    ],
    setupHelp: "Provide the Slack email for the review subject when prompted.",
  },
];

export const questionInputExample =
  "Example: Focus on architectural impact, cross-team collaboration, and mentoring outcomes.";
