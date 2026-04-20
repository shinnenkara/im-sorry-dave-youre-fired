import { afterEach, describe, expect, test } from "vitest";

import { runReadinessChecks } from "../src/setup/readiness.js";

const originalAnthropicKey = process.env.ANTHROPIC_API_KEY;

afterEach(() => {
  if (typeof originalAnthropicKey === "string") {
    process.env.ANTHROPIC_API_KEY = originalAnthropicKey;
  } else {
    delete process.env.ANTHROPIC_API_KEY;
  }
});

describe("runReadinessChecks", () => {
  test("reports Anthropic as not ready without API key", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const checks = await runReadinessChecks(["anthropic"]);
    expect(checks.anthropic.ok).toBe(false);
    expect(checks.anthropic.message).toContain("ANTHROPIC_API_KEY");
  });

  test("reports Anthropic as ready with API key", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    const checks = await runReadinessChecks(["anthropic"]);
    expect(checks.anthropic.ok).toBe(true);
  });
});
