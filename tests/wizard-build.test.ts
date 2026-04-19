import { describe, expect, test } from "vitest";

import { parseReviewConfigFromUnknown } from "../src/config/schema.js";
import { buildWizardConfig } from "../src/cli/wizard/buildWizardConfig.js";

describe("buildWizardConfig", () => {
  test("builds a config with github and clickup providers", () => {
    const raw = buildWizardConfig({
      displayName: "Jane Doe",
      timeframe: "last_6_months",
      questionsText: "What did Jane deliver?;How did Jane collaborate?",
      github: {
        username: "janedoe",
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
    expect(config.reviewQuestions).toEqual([
      "What did Jane deliver?",
      "How did Jane collaborate?",
    ]);
    expect(config.providers.code?.type).toBe("github-cli");
    expect(config.providers.tasks?.type).toBe("clickup-mcp");
  });

  test("builds single-question configs and keeps only selected providers", () => {
    const raw = buildWizardConfig({
      displayName: "Jane Doe",
      timeframe: "last_3_months",
      questionsText: "Focus on architecture impact",
      github: {
        username: "janedoe",
        repositories: ["acme/web"],
      },
    });
    const config = parseReviewConfigFromUnknown(raw, {
      interpolateEnv: false,
      referenceDate: new Date("2026-06-01T00:00:00.000Z"),
    });

    expect(config.reviewQuestions).toEqual(["Focus on architecture impact"]);
    expect(config.providers.code?.repo).toEqual(["acme/web"]);
    expect(config.providers.tasks).toBeUndefined();
  });

  test("splits multiline topics into multiple review questions", () => {
    const raw = buildWizardConfig({
      displayName: "Jane Doe",
      timeframe: "last_6_months",
      questionsText: "What did Jane deliver?\nHow did Jane collaborate?",
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
});
