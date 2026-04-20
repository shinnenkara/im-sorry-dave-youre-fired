import { CLAUDE_REVIEW_MODELS, DEFAULT_REVIEW_MODELS } from "../../config/defaults.js";

interface BuildWizardConfigInput {
  displayName: string;
  timeframe: "last_3_months" | "last_6_months" | "last_12_months";
  notableProjectsText?: string;
  questionsText: string;
  modelPreset: "gemini-default" | "claude-default";
  github?: {
    username: string;
    org?: string;
    repositories?: string[];
  };
  clickup?: {
    email: string;
  };
  slack?: {
    email: string;
  };
}

function parseQuestions(questionsText: string): string[] {
  const normalized = questionsText
    .split(/\r?\n|;/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (normalized.length > 0) {
    return normalized;
  }
  return [questionsText.trim()];
}

export function buildWizardConfig(input: BuildWizardConfigInput): unknown {
  const providers: Record<string, unknown> = {};
  const models = input.modelPreset === "claude-default" ? CLAUDE_REVIEW_MODELS : DEFAULT_REVIEW_MODELS;
  const notableProjects = input.notableProjectsText?.trim();
  const subject: Record<string, string> = {
    displayName: input.displayName.trim(),
  };

  if (input.github) {
    subject.githubUsername = input.github.username.trim();
    const org = input.github.org?.trim();
    const repositories = input.github.repositories?.map((entry) => entry.trim()).filter((entry) => entry.length > 0);
    providers.code = {
      enabled: true,
      type: "github-cli",
      ...(org ? { org } : {}),
      ...(repositories && repositories.length > 0 ? { repo: repositories } : {}),
      prLimit: 500,
    };
  }

  if (input.clickup) {
    providers.tasks = {
      enabled: true,
      type: "clickup-mcp",
      server: "clickup",
      user: input.clickup.email.trim(),
      tools: {
        search: "clickup_search",
      },
    };
  }

  if (input.slack) {
    subject.email = input.slack.email.trim();
    providers.comms = {
      enabled: true,
      type: "slack-mcp",
      server: "slack",
      expectedUserEmail: input.slack.email.trim(),
      tools: {
        search: "search_messages",
      },
    };
  }

  return {
    timeframe: input.timeframe,
    subject,
    ...(notableProjects ? { notableProjects } : {}),
    reviewQuestions: parseQuestions(input.questionsText),
    models: {
      fast: models.fast,
      pro: models.pro,
    },
    providers,
  };
}
