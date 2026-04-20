import { confirm, editor, input, select } from "@inquirer/prompts";

import { CLAUDE_REVIEW_MODELS, DEFAULT_REVIEW_MODELS } from "../../config/defaults.js";
import { parseReviewConfigFromUnknown } from "../../config/schema.js";
import type { ReviewConfig } from "../../config/types.js";
import {
  providerWizardMeta,
  timeframeOptions,
  type ProviderSlot,
  type ProviderType,
} from "../../setup/providerWizardMeta.js";
import { runReadinessChecks, type ReadinessResult } from "../../setup/readiness.js";

import { buildWizardConfig } from "./buildWizardConfig.js";

interface SelectedProviders {
  code?: "github-cli";
  tasks?: "clickup-mcp";
  comms?: "slack-mcp";
}

type ModelProviderSelection = "gemini-default" | "claude-default";
type ModelReadinessCheck = "gemini" | "anthropic";

interface ModelProviderOption {
  id: ModelProviderSelection;
  label: string;
  models: {
    fast: string;
    pro: string;
  };
  readinessCheck: ModelReadinessCheck;
}

const modelProviderOptions: readonly ModelProviderOption[] = [
  {
    id: "gemini-default",
    label: "Gemini (recommended)",
    models: DEFAULT_REVIEW_MODELS,
    readinessCheck: "gemini",
  },
  {
    id: "claude-default",
    label: "Claude",
    models: CLAUDE_REVIEW_MODELS,
    readinessCheck: "anthropic",
  },
];

function formatReadinessSuffix(result: ReadinessResult | undefined): string {
  if (!result) {
    return "";
  }
  if (result.ok) {
    return "Ready";
  }
  return `Not ready: ${result.message}`;
}

function formatProviderSummary(providers: SelectedProviders): string {
  const selected: string[] = [];
  if (providers.code === "github-cli") {
    selected.push("code=GitHub");
  }
  if (providers.tasks === "clickup-mcp") {
    selected.push("tasks=ClickUp");
  }
  if (providers.comms === "slack-mcp") {
    selected.push("comms=Slack");
  }
  return selected.length > 0 ? selected.join(", ") : "none";
}

function getModelProviderOption(selection: ModelProviderSelection): ModelProviderOption {
  const option = modelProviderOptions.find((item) => item.id === selection);
  if (!option) {
    throw new Error(`Unsupported model provider selection: ${selection}`);
  }
  return option;
}

function formatModelSummary(selection: ModelProviderSelection): string {
  const option = getModelProviderOption(selection);
  return `${option.models.fast} + ${option.models.pro}`;
}

function formatReviewQuestionsForSummary(questions: string): string[] {
  return questions
    .split(/\r?\n|;/u)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

async function collectReviewTopics(): Promise<string> {
  return editor({
    message: "What topics should the review focus on? (one per line is best)",
    validate: (value) => (value.trim().length > 0 ? true : "At least one review topic is required."),
  });
}

async function collectNotableProjectsHint(): Promise<string> {
  return editor({
    message:
      "Optional: list notable projects or workstreams to prioritize in planning/search (one per line is best). Leave empty to skip.",
    validate: () => true,
  });
}

async function selectProviderForSlot(
  slot: ProviderSlot,
  checksById: Record<string, ReadinessResult>,
): Promise<ProviderType | "skip"> {
  const provider = providerWizardMeta.find((entry) => entry.slot === slot);
  if (!provider) {
    return "skip";
  }
  const readiness = checksById[provider.readinessCheck];
  const choices = [
    {
      value: provider.type,
      name: provider.label,
      description: `${provider.description} ${formatReadinessSuffix(readiness)}`.trim(),
      disabled: readiness?.ok ? false : readiness?.setupHelp ?? readiness?.message ?? "Not ready",
    },
    {
      value: "more-soon",
      name: "More supported soon",
      disabled: "Not available yet",
    },
    {
      value: "skip",
      name: "Skip this provider",
      description: "Do not collect evidence from this provider slot.",
    },
  ] as const;

  const selected = await select({
    message: `Select ${slot} provider`,
    choices,
  });
  if (selected === "more-soon") {
    return "skip";
  }
  return selected;
}

async function collectGithubRepositories(): Promise<string[]> {
  const raw = await editor({
    message:
      "Optional: list preferred GitHub repositories (owner/repo). Use one per line or ';' separators. Leave empty to search broadly.",
    validate: (value) => {
      const repositories = value
        .split(/\r?\n|;/u)
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
      for (const repository of repositories) {
        if (!/^(repo:)?[^/\s]+\/[^/\s]+$/u.test(repository)) {
          return `Use owner/repo format (or repo:owner/repo): "${repository}"`;
        }
      }
      return true;
    },
  });
  return raw
    .split(/\r?\n|;/u)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export async function runInteractiveSetup(): Promise<ReviewConfig> {
  const checks = await runReadinessChecks(["gemini", "anthropic", "github-cli", "clickup-mcp", "slack-mcp"]);
  if (!checks.gemini.ok && !checks.anthropic.ok) {
    throw new Error(
      [
        "No model provider is ready.",
        `Gemini: ${checks.gemini.setupHelp ?? checks.gemini.message}`,
        `Claude: ${checks.anthropic.setupHelp ?? checks.anthropic.message}`,
      ].join(" "),
    );
  }

  const displayName = await input({
    message: "Who is this review for?",
    validate: (value) => (value.trim().length > 0 ? true : "Display name is required."),
  });

  const timeframe = await select({
    message: "Timeframe for the review",
    choices: timeframeOptions.map((option) => ({
      value: option.value,
      name: option.label,
    })),
    default: "last_6_months",
  });

  const notableProjectsText = await collectNotableProjectsHint();
  const questionsText = await collectReviewTopics();

  const modelProviderChoices = modelProviderOptions.map((option) => {
    const readiness = checks[option.readinessCheck];
    return {
      value: option.id,
      name: `${option.label}: ${option.models.fast} + ${option.models.pro}`,
      description: formatReadinessSuffix(readiness),
      disabled: readiness.ok ? false : readiness.setupHelp ?? readiness.message ?? "Not ready",
    };
  });
  const defaultModelProvider: ModelProviderSelection =
    modelProviderOptions.find((option) => checks[option.readinessCheck].ok)?.id ?? "gemini-default";

  const selectedModelProvider = await select<ModelProviderSelection>({
    message: "Model provider",
    choices: modelProviderChoices,
    default: defaultModelProvider,
  });

  let selectedProviders: SelectedProviders = {};
  while (true) {
    const codeSelection = await selectProviderForSlot("code", checks);
    const tasksSelection = await selectProviderForSlot("tasks", checks);
    const commsSelection = await selectProviderForSlot("comms", checks);

    selectedProviders = {
      ...(codeSelection === "github-cli" ? { code: "github-cli" } : {}),
      ...(tasksSelection === "clickup-mcp" ? { tasks: "clickup-mcp" } : {}),
      ...(commsSelection === "slack-mcp" ? { comms: "slack-mcp" } : {}),
    };
    if (selectedProviders.code || selectedProviders.tasks || selectedProviders.comms) {
      break;
    }
    process.stderr.write("At least one provider must be selected.\n");
  }

  let githubUsername: string | undefined;
  let githubOrg: string | undefined;
  let githubRepositories: string[] | undefined;
  if (selectedProviders.code === "github-cli") {
    const evidenceNotes = providerWizardMeta.find((entry) => entry.type === "github-cli")?.evidenceLooksFor ?? [];
    process.stderr.write(`GitHub provider will look for:\n- ${evidenceNotes.join("\n- ")}\n`);
    githubUsername = await input({
      message: "GitHub username to search",
      validate: (value) => (value.trim().length > 0 ? true : "GitHub username is required."),
    });
    githubOrg = await input({
      message: "GitHub organization to scope search (optional)",
      validate: (value) => {
        const trimmed = value.trim();
        if (!trimmed) {
          return true;
        }
        return /^(org:)?[^\s/]+$/u.test(trimmed)
          ? true
          : "Use an org slug like carbmee (or org:carbmee).";
      },
    });
    githubRepositories = await collectGithubRepositories();
  }

  let clickupEmail: string | undefined;
  if (selectedProviders.tasks === "clickup-mcp") {
    const evidenceNotes = providerWizardMeta.find((entry) => entry.type === "clickup-mcp")?.evidenceLooksFor ?? [];
    process.stderr.write(`ClickUp provider will look for:\n- ${evidenceNotes.join("\n- ")}\n`);
    clickupEmail = await input({
      message: "ClickUp user email",
      validate: (value) => {
        const trimmed = value.trim();
        if (!trimmed) {
          return "ClickUp email is required.";
        }
        if (!trimmed.includes("@")) {
          return "Enter a valid email address.";
        }
        return true;
      },
    });
  }

  let slackEmail: string | undefined;
  if (selectedProviders.comms === "slack-mcp") {
    const evidenceNotes = providerWizardMeta.find((entry) => entry.type === "slack-mcp")?.evidenceLooksFor ?? [];
    process.stderr.write(`Slack provider will look for:\n- ${evidenceNotes.join("\n- ")}\n`);
    slackEmail = await input({
      message: "Slack user email",
      validate: (value) => {
        const trimmed = value.trim();
        if (!trimmed) {
          return "Slack email is required.";
        }
        if (!trimmed.includes("@")) {
          return "Enter a valid email address.";
        }
        return true;
      },
    });
  }

  const topics = formatReviewQuestionsForSummary(questionsText);
  process.stderr.write(
    [
      "",
      "Please confirm your setup:",
      `- Display name: ${displayName.trim()}`,
      `- Timeframe: ${timeframe}`,
      notableProjectsText.trim().length > 0
        ? `- Notable projects/workstreams hint: ${notableProjectsText.trim().replace(/\s*\n\s*/gu, " | ")}`
        : undefined,
      `- Topics: ${topics.length > 0 ? topics.join(" | ") : questionsText.trim()}`,
      `- Models: ${formatModelSummary(selectedModelProvider)}`,
      `- Providers: ${formatProviderSummary(selectedProviders)}`,
      githubUsername ? `- GitHub username: ${githubUsername.trim()}` : undefined,
      githubOrg?.trim() ? `- GitHub org scope: ${githubOrg.trim()}` : undefined,
      githubRepositories && githubRepositories.length > 0
        ? `- Preferred repositories: ${githubRepositories.join(", ")}`
        : undefined,
      clickupEmail ? `- ClickUp email: ${clickupEmail.trim()}` : undefined,
      slackEmail ? `- Slack subject email: ${slackEmail.trim()}` : undefined,
      "",
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n"),
  );

  const approved = await confirm({
    message: "Run with this setup?",
    default: true,
  });
  if (!approved) {
    throw new Error("Interactive setup cancelled.");
  }

  const rawConfig = buildWizardConfig({
    displayName,
    timeframe,
    notableProjectsText,
    questionsText,
    modelPreset: selectedModelProvider,
    github:
      selectedProviders.code === "github-cli" && githubUsername
        ? { username: githubUsername, org: githubOrg, repositories: githubRepositories }
        : undefined,
    clickup:
      selectedProviders.tasks === "clickup-mcp" && clickupEmail
        ? { email: clickupEmail }
        : undefined,
    slack:
      selectedProviders.comms === "slack-mcp" && slackEmail
        ? { email: slackEmail }
        : undefined,
  });

  return parseReviewConfigFromUnknown(rawConfig, { interpolateEnv: false });
}
