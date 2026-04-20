import { describe, expect, test } from "vitest";

import { rankRowsByPreferredRepos } from "../src/providers/githubCli.js";

describe("rankRowsByPreferredRepos", () => {
  test("moves preferred repositories to the front while preserving original order", () => {
    const rows = [
      { number: 1, title: "one", url: "https://example.com/1", repository: { nameWithOwner: "acme/infra" } },
      { number: 2, title: "two", url: "https://example.com/2", repository: { nameWithOwner: "acme/web" } },
      { number: 3, title: "three", url: "https://example.com/3", repository: { nameWithOwner: "acme/api" } },
      { number: 4, title: "four", url: "https://example.com/4", repository: { nameWithOwner: "acme/web" } },
    ];

    const ranked = rankRowsByPreferredRepos(rows, new Set(["acme/web", "acme/api"]));

    expect(ranked.rows.map((row) => row.number)).toEqual([2, 3, 4, 1]);
    expect(ranked.preferredCount).toBe(3);
    expect(ranked.nonPreferredCount).toBe(1);
  });

  test("returns original order and counts when no preferred repos are configured", () => {
    const rows = [
      { number: 1, title: "one", url: "https://example.com/1", repository: { nameWithOwner: "acme/infra" } },
      { number: 2, title: "two", url: "https://example.com/2", repository: { nameWithOwner: "acme/web" } },
    ];

    const ranked = rankRowsByPreferredRepos(rows, new Set());

    expect(ranked.rows.map((row) => row.number)).toEqual([1, 2]);
    expect(ranked.preferredCount).toBe(0);
    expect(ranked.nonPreferredCount).toBe(2);
  });
});
