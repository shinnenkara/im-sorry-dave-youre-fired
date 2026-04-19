import { describe, expect, test } from "vitest";

import { resolveTimeframeInput } from "../src/config/timeframe.js";

describe("resolveTimeframeInput", () => {
  const ref = new Date("2026-04-17T12:00:00.000Z");

  test("resolves rolling preset from string", () => {
    const resolved = resolveTimeframeInput("last_3_months", ref);
    expect(resolved.slug).toBe("last-3-months");
    expect(resolved.label).toMatch(/Jan 17,\s*2026/);
    expect(resolved.label).toMatch(/Apr 17,\s*2026/);
    expect(resolved.label).toContain("last 3 months");
    expect(resolved.providerScope).toMatch(/^2026-01-17 to 2026-04-17/);
  });

  test("resolves rolling preset from object", () => {
    const resolved = resolveTimeframeInput({ preset: "last_12_months" }, ref);
    expect(resolved.slug).toBe("last-12-months");
    expect(resolved.providerScope).toContain("2025-04-17");
    expect(resolved.providerScope).toContain("2026-04-17");
  });

  test("resolves custom range", () => {
    const resolved = resolveTimeframeInput(
      { preset: "custom", start: "2026-01-01", end: "2026-03-31" },
      ref,
    );
    expect(resolved.slug).toBe("2026-01-01-to-2026-03-31");
    expect(resolved.label).toContain("custom range");
    expect(resolved.providerScope).toContain("2026-01-01");
  });

  test("rejects custom range with start after end", () => {
    expect(() =>
      resolveTimeframeInput({ preset: "custom", start: "2026-04-01", end: "2026-01-01" }, ref),
    ).toThrow(/on or before end/);
  });

  test("preserves legacy freeform string", () => {
    const resolved = resolveTimeframeInput("Q2 2026", ref);
    expect(resolved.label).toBe("Q2 2026");
    expect(resolved.slug).toBe("q2-2026");
    expect(resolved.providerScope).toBe("Q2 2026");
  });
});
