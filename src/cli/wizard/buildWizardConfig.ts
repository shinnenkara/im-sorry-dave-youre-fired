import { DEFAULT_REVIEW_MODELS } from "../../config/defaults.js";

interface BuildWizardConfigInput {
  displayName: string;
  timeframe: "last_3_months" | "last_6_months" | "last_12_months";
  questionsText: string;
  github?: {
    username: string;
    repositories: string[];
  };
  clickup?: {
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
  const subject: Record<string, string> = {
    displayName: input.displayName.trim(),
  };

  if (input.github) {
    subject.githubUsername = input.github.username.trim();
    providers.code = {
      enabled: true,
      type: "github-cli",
      repo: input.github.repositories,
      prLimit: 100,
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

  return {
    timeframe: input.timeframe,
    subject,
    reviewQuestions: parseQuestions(input.questionsText),
    models: {
      fast: DEFAULT_REVIEW_MODELS.fast,
      pro: DEFAULT_REVIEW_MODELS.pro,
    },
    providers,
  };
}
