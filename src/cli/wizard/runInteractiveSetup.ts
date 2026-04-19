import { confirm, editor, input, select } from "@inquirer/prompts";

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
  comms?: never;
}

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
  return selected.length > 0 ? selected.join(", ") : "none";
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
  const repositories: string[] = [];
  let keepAsking = true;
  while (keepAsking) {
    const repository = await input({
      message: "GitHub repository to include (owner/repo)",
      validate: (value) => {
        const trimmed = value.trim();
        if (!trimmed) {
          return "Repository is required.";
        }
        if (!/^[^/\s]+\/[^/\s]+$/u.test(trimmed)) {
          return "Use owner/repo format.";
        }
        return true;
      },
    });
    repositories.push(repository.trim());
    keepAsking = await confirm({
      message: "Add another repository?",
      default: false,
    });
  }
  return repositories;
}

export async function runInteractiveSetup(): Promise<ReviewConfig> {
  const checks = await runReadinessChecks(["gemini", "github-cli", "clickup-mcp", "slack-mcp"]);
  if (!checks.gemini.ok) {
    throw new Error(
      `${checks.gemini.message} ${checks.gemini.setupHelp ?? "Please complete setup and try again."}`.trim(),
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

  const questionsText = await collectReviewTopics();

  await select({
    message: "Model provider",
    choices: [
      {
        value: "gemini-default",
        name: "Gemini (recommended): gemini-2.5-flash + gemini-2.5-pro",
        description: "Enabled",
      },
      {
        value: "more-soon",
        name: "More supported soon",
        disabled: "Not available yet",
      },
    ],
    default: "gemini-default",
  });

  let selectedProviders: SelectedProviders = {};
  while (true) {
    const codeSelection = await selectProviderForSlot("code", checks);
    const tasksSelection = await selectProviderForSlot("tasks", checks);
    await selectProviderForSlot("comms", checks);

    selectedProviders = {
      ...(codeSelection === "github-cli" ? { code: "github-cli" } : {}),
      ...(tasksSelection === "clickup-mcp" ? { tasks: "clickup-mcp" } : {}),
    };
    if (selectedProviders.code || selectedProviders.tasks) {
      break;
    }
    process.stderr.write("At least one provider must be selected.\n");
  }

  let githubUsername: string | undefined;
  let githubRepositories: string[] | undefined;
  if (selectedProviders.code === "github-cli") {
    const evidenceNotes = providerWizardMeta.find((entry) => entry.type === "github-cli")?.evidenceLooksFor ?? [];
    process.stderr.write(`GitHub provider will look for:\n- ${evidenceNotes.join("\n- ")}\n`);
    githubUsername = await input({
      message: "GitHub username to search",
      validate: (value) => (value.trim().length > 0 ? true : "GitHub username is required."),
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

  const topics = formatReviewQuestionsForSummary(questionsText);
  process.stderr.write(
    [
      "",
      "Please confirm your setup:",
      `- Display name: ${displayName.trim()}`,
      `- Timeframe: ${timeframe}`,
      `- Topics: ${topics.length > 0 ? topics.join(" | ") : questionsText.trim()}`,
      `- Providers: ${formatProviderSummary(selectedProviders)}`,
      githubUsername ? `- GitHub username: ${githubUsername.trim()}` : undefined,
      githubRepositories ? `- Repositories: ${githubRepositories.join(", ")}` : undefined,
      clickupEmail ? `- ClickUp email: ${clickupEmail.trim()}` : undefined,
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
    questionsText,
    github:
      selectedProviders.code === "github-cli" && githubUsername && githubRepositories
        ? { username: githubUsername, repositories: githubRepositories }
        : undefined,
    clickup:
      selectedProviders.tasks === "clickup-mcp" && clickupEmail
        ? { email: clickupEmail }
        : undefined,
  });

  return parseReviewConfigFromUnknown(rawConfig, { interpolateEnv: false });
}
