import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { loadReviewConfig, parseReviewConfigFromUnknown } from "../src/config/schema.js";

describe("loadReviewConfig", () => {
  test("parses yaml config", async () => {
    const dir = await mkdtemp(join(tmpdir(), "review-config-"));
    const configPath = join(dir, "review.yaml");
    await writeFile(
      configPath,
      `
timeframe: last_3_months
subject:
  displayName: Jane Doe
reviewQuestions:
  - What did Jane deliver?
providers:
  code:
    enabled: true
    type: github-cli
    prLimit: 10
`,
      "utf8",
    );

    const config = await loadReviewConfig(configPath, { referenceDate: new Date("2026-06-01T00:00:00.000Z") });
    expect(config.subject.displayName).toBe("Jane Doe");
    expect(config.providers.code?.type).toBe("github-cli");
    expect(config.timeframe.slug).toBe("last-3-months");
    expect(config.timeframe.label).toContain("last 3 months");
  });

  test("applies top-level defaults for optional fields", async () => {
    const dir = await mkdtemp(join(tmpdir(), "review-config-defaults-"));
    const configPath = join(dir, "review.yaml");
    await writeFile(
      configPath,
      `
timeframe: last_3_months
subject:
  displayName: Jane Doe
reviewQuestions:
  - What did Jane deliver?
providers:
  code:
    type: github-cli
`,
      "utf8",
    );

    const config = await loadReviewConfig(configPath);
    expect(config.outDir).toBe("out");
    expect(config.maxContextChars).toBe(120000);
    expect(config.models.fast).toBe("gemini-2.5-flash");
    expect(config.models.pro).toBe("gemini-2.5-pro");
    expect(config.providers.code?.enabled).toBe(true);
    expect(config.providers.code?.prLimit).toBe(500);
  });

  test("accepts github repo arrays and debug output path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "review-config-github-array-"));
    const configPath = join(dir, "review.yaml");
    await writeFile(
      configPath,
      `
timeframe: last_3_months
subject:
  displayName: Jane Doe
reviewQuestions:
  - What did Jane deliver?
providers:
  code:
    enabled: true
    type: github-cli
    org: acme
    repo:
      - acme/app
      - acme/api
    debugOutputPath: ./out/github-debug.json
    prLimit: 10
`,
      "utf8",
    );

    const config = await loadReviewConfig(configPath, { referenceDate: new Date("2026-06-01T00:00:00.000Z") });
    expect(config.providers.code?.org).toBe("acme");
    expect(config.providers.code?.repo).toEqual(["acme/app", "acme/api"]);
    expect(config.providers.code?.debugOutputPath).toBe("./out/github-debug.json");
  });

  test("interpolates environment variables in config values", async () => {
    const dir = await mkdtemp(join(tmpdir(), "review-config-env-"));
    const configPath = join(dir, "review.yaml");
    process.env.MCP_SERVER_TOKEN = "test-mcp-token";
    await writeFile(
      configPath,
      `
timeframe: Q3 2026
subject:
  displayName: Jane Doe
reviewQuestions:
  - What did Jane deliver?
mcpServers:
  clickup:
    command: npx
    args: ["-y", "some-server"]
    env:
      AUTH_TOKEN: \${MCP_SERVER_TOKEN}
providers:
  tasks:
    enabled: true
    type: clickup-mcp
    server: clickup
    tools:
      search: search_tasks
`,
      "utf8",
    );

    const config = await loadReviewConfig(configPath);
    expect(config.mcpServers.clickup?.env?.AUTH_TOKEN).toBe("test-mcp-token");
  });

  test("throws when a referenced environment variable is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "review-config-env-missing-"));
    const configPath = join(dir, "review.yaml");
    delete process.env.MCP_SERVER_TOKEN;
    await writeFile(
      configPath,
      `
timeframe: Q3 2026
subject:
  displayName: Jane Doe
reviewQuestions:
  - What did Jane deliver?
mcpServers:
  clickup:
    command: npx
    env:
      AUTH_TOKEN: \${MCP_SERVER_TOKEN}
providers:
  tasks:
    enabled: true
    type: clickup-mcp
    server: clickup
    tools:
      search: search_tasks
`,
      "utf8",
    );

    await expect(loadReviewConfig(configPath)).rejects.toThrow(
      'Missing environment variable "MCP_SERVER_TOKEN" referenced in config',
    );
  });

  test("rejects unknown provider type", async () => {
    const dir = await mkdtemp(join(tmpdir(), "review-config-provider-type-"));
    const configPath = join(dir, "review.yaml");
    await writeFile(
      configPath,
      `
timeframe: last_3_months
subject:
  displayName: Jane Doe
reviewQuestions:
  - What did Jane deliver?
providers:
  tasks:
    type: not-a-provider
    server: clickup
    tools:
      search: search_tasks
`,
      "utf8",
    );

    await expect(loadReviewConfig(configPath)).rejects.toThrow("Invalid input");
  });

  test("parses wizard-like config object without env interpolation", () => {
    const config = parseReviewConfigFromUnknown(
      {
        timeframe: "last_6_months",
        subject: {
          displayName: "Jane ${LAST_NAME}",
        },
        notableProjects: " Apollo migration ",
        reviewQuestions: ["What did Jane deliver?"],
        providers: {
          code: {
            type: "github-cli",
            org: "acme",
            repo: ["acme/app"],
          },
        },
      },
      { interpolateEnv: false, referenceDate: new Date("2026-06-01T00:00:00.000Z") },
    );

    expect(config.subject.displayName).toBe("Jane ${LAST_NAME}");
    expect(config.notableProjects).toBe("Apollo migration");
    expect(config.timeframe.slug).toBe("last-6-months");
    expect(config.providers.code?.org).toBe("acme");
    expect(config.providers.code?.prLimit).toBe(500);
    expect(config.models.pro).toBe("gemini-2.5-pro");
  });

  test("normalizes blank notable projects to undefined", () => {
    const config = parseReviewConfigFromUnknown(
      {
        timeframe: "last_6_months",
        subject: {
          displayName: "Jane Doe",
        },
        notableProjects: "   ",
        reviewQuestions: ["What did Jane deliver?"],
        providers: {
          code: {
            type: "github-cli",
          },
        },
      },
      { interpolateEnv: false, referenceDate: new Date("2026-06-01T00:00:00.000Z") },
    );

    expect(config.notableProjects).toBeUndefined();
  });

  test("requires at least one provider for parsed object configs", () => {
    expect(() =>
      parseReviewConfigFromUnknown(
        {
          timeframe: "last_6_months",
          subject: {
            displayName: "Jane Doe",
          },
          reviewQuestions: ["What did Jane deliver?"],
          providers: {},
        },
        { interpolateEnv: false },
      ),
    ).toThrow("At least one provider must be configured");
  });
});
