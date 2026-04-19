import type { EvidenceSource, NormalizedEvidence } from "../providers/contracts.js";

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function extractTitle(value: string): string {
  const firstLine = value.split("\n").map((line) => line.trim()).find(Boolean);
  if (!firstLine) {
    return "Untitled evidence";
  }
  return firstLine.slice(0, 120);
}

export function normalizeTextChunks(
  source: EvidenceSource,
  chunks: readonly string[],
  citationPrefix: string,
): NormalizedEvidence[] {
  return chunks
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk, index) => {
      const summary = compactWhitespace(chunk).slice(0, 1800);
      const id = `${source}-${index + 1}`;
      return {
        id,
        source,
        title: extractTitle(chunk),
        summary,
        citation: `${citationPrefix}-${index + 1}`,
      };
    });
}

export function renderEvidenceForPrompt(items: readonly NormalizedEvidence[]): string {
  if (items.length === 0) {
    return "No evidence returned for this provider.";
  }

  return items
    .map((item) => {
      return [
        `Citation: ${item.citation}`,
        `Title: ${item.title}`,
        item.occurredAt ? `OccurredAt: ${item.occurredAt}` : undefined,
        item.url ? `URL: ${item.url}` : undefined,
        `Summary: ${item.summary}`,
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");
}
