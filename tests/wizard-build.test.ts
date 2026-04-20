import { describe, expect, test } from "vitest";

import { parseReviewConfigFromUnknown } from "../src/config/schema.js";
import { buildWizardConfig } from "../src/cli/wizard/buildWizardConfig.js";

describe("buildWizardConfig", () => {
  test("builds a config with github and clickup providers", () => {
    const raw = buildWizardConfig({
      displayName: "Jane Doe",
      timeframe: "last_6_months",
      notableProjectsText: "Apollo migration\nMajor incidents",
      questionsText: "What did Jane deliver?;How did Jane collaborate?",
      modelPreset: "gemini-default",
      github: {
        username: "janedoe",
        org: "acme",
        repositories: ["acme/web", "acme/api"],
      },
      clickup: {
        email: "jane.doe@acme.com",
      },
    });
    const config = parseReviewConfigFromUnknown(raw, {
      interpolateEnv: false,
      referenceDate: new Date("2026-06-01T00:00:00.000Z"),
    });

    expect(config.subject.displayName).toBe("Jane Doe");
    expect(config.subject.githubUsername).toBe("janedoe");
    expect(config.notableProjects).toBe("Apollo migration\nMajor incidents");
    expect(config.reviewQuestions).toEqual([
      "What did Jane deliver?",
      "How did Jane collaborate?",
    ]);
    expect(config.providers.code?.type).toBe("github-cli");
    expect(config.providers.code?.org).toBe("acme");
    expect(config.providers.tasks?.type).toBe("clickup-mcp");
  });

  test("builds single-question configs and keeps only selected providers", () => {
    const raw = buildWizardConfig({
      displayName: "Jane Doe",
      timeframe: "last_3_months",
      questionsText: "Focus on architecture impact",
      modelPreset: "gemini-default",
      github: {
        username: "janedoe",
        org: "acme",
        repositories: ["acme/web"],
      },
    });
    const config = parseReviewConfigFromUnknown(raw, {
      interpolateEnv: false,
      referenceDate: new Date("2026-06-01T00:00:00.000Z"),
    });

    expect(config.reviewQuestions).toEqual(["Focus on architecture impact"]);
    expect(config.providers.code?.org).toBe("acme");
    expect(config.providers.code?.repo).toEqual(["acme/web"]);
    expect(config.providers.tasks).toBeUndefined();
  });

  test("omits notable projects when wizard input is blank", () => {
    const raw = buildWizardConfig({
      displayName: "Jane Doe",
      timeframe: "last_3_months",
      notableProjectsText: "   ",
      questionsText: "Focus on architecture impact",
      modelPreset: "gemini-default",
      github: {
        username: "janedoe",
      },
    });
    const config = parseReviewConfigFromUnknown(raw, {
      interpolateEnv: false,
      referenceDate: new Date("2026-06-01T00:00:00.000Z"),
    });

    expect(config.notableProjects).toBeUndefined();
  });

  test("keeps github provider enabled when no preferred repositories are configured", () => {
    const raw = buildWizardConfig({
      displayName: "Jane Doe",
      timeframe: "last_3_months",
      questionsText: "Focus on architecture impact",
      modelPreset: "gemini-default",
      github: {
        username: "janedoe",
        org: "acme",
      },
    });
    const config = parseReviewConfigFromUnknown(raw, {
      interpolateEnv: false,
      referenceDate: new Date("2026-06-01T00:00:00.000Z"),
    });

    expect(config.providers.code?.type).toBe("github-cli");
    expect(config.providers.code?.org).toBe("acme");
    expect(config.providers.code?.repo).toBeUndefined();
  });

  test("splits multiline topics into multiple review questions", () => {
    const raw = buildWizardConfig({
      displayName: "Jane Doe",
      timeframe: "last_6_months",
      questionsText: "What did Jane deliver?\nHow did Jane collaborate?",
      modelPreset: "gemini-default",
      github: {
        username: "janedoe",
        repositories: ["acme/web"],
      },
    });
    const config = parseReviewConfigFromUnknown(raw, {
      interpolateEnv: false,
      referenceDate: new Date("2026-06-01T00:00:00.000Z"),
    });

    expect(config.reviewQuestions).toEqual([
      "What did Jane deliver?",
      "How did Jane collaborate?",
    ]);
  });

  test("builds a Slack-only config using subject email", () => {
    const raw = buildWizardConfig({
      displayName: "Jane Doe",
      timeframe: "last_6_months",
      questionsText: "How did Jane communicate cross-functionally?",
      modelPreset: "gemini-default",
      slack: {
        email: "jane.doe@acme.com",
      },
    });
    const config = parseReviewConfigFromUnknown(raw, {
      interpolateEnv: false,
      referenceDate: new Date("2026-06-01T00:00:00.000Z"),
    });

    expect(config.subject.email).toBe("jane.doe@acme.com");
    expect(config.providers.comms?.type).toBe("slack-mcp");
    expect(config.providers.comms?.expectedUserEmail).toBeUndefined();
    expect(config.providers.comms?.tools.search).toBe("search_messages");
    expect(config.providers.tasks).toBeUndefined();
    expect(config.providers.code).toBeUndefined();
  });

  test("builds Claude model defaults when Claude preset is selected", () => {
    const raw = buildWizardConfig({
      displayName: "Jane Doe",
      timeframe: "last_6_months",
      questionsText: "What did Jane deliver?",
      modelPreset: "claude-default",
      github: {
        username: "janedoe",
        repositories: ["acme/web"],
      },
    });
    const config = parseReviewConfigFromUnknown(raw, {
      interpolateEnv: false,
      referenceDate: new Date("2026-06-01T00:00:00.000Z"),
    });

    expect(config.models.fast).toBe("claude-haiku-4-5");
    expect(config.models.pro).toBe("claude-sonnet-4-6");
  });
});
