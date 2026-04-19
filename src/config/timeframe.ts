import type { ResolvedTimeframe, TimeframeYaml } from "./types.js";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const PRESET_MONTHS = {
  last_3_months: 3,
  last_6_months: 6,
  last_12_months: 12,
} as const;

const PRESET_LABEL: Record<keyof typeof PRESET_MONTHS, string> = {
  last_3_months: "last 3 months",
  last_6_months: "last 6 months",
  last_12_months: "last 12 months",
};

const PRESET_SLUG: Record<keyof typeof PRESET_MONTHS, string> = {
  last_3_months: "last-3-months",
  last_6_months: "last-6-months",
  last_12_months: "last-12-months",
};

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

function isValidIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) {
    return false;
  }
  const parsed = new Date(`${value}T12:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function utcCalendarDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function addCalendarMonths(isoDate: string, deltaMonths: number): string {
  const parsed = new Date(`${isoDate}T12:00:00.000Z`);
  parsed.setUTCMonth(parsed.getUTCMonth() + deltaMonths);
  return parsed.toISOString().slice(0, 10);
}

function formatMediumUtc(isoDate: string): string {
  const parsed = new Date(`${isoDate}T12:00:00.000Z`);
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(parsed);
}

function normalizeRollingPreset(raw: string): keyof typeof PRESET_MONTHS | undefined {
  const trimmed = raw.trim();
  if (trimmed in PRESET_MONTHS) {
    return trimmed as keyof typeof PRESET_MONTHS;
  }
  return undefined;
}

export function resolveTimeframeInput(raw: TimeframeYaml, now: Date = new Date()): ResolvedTimeframe {
  if (typeof raw === "string") {
    const preset = normalizeRollingPreset(raw);
    if (preset) {
      return resolveTimeframeInput({ preset }, now);
    }
    const label = raw.trim();
    if (label.length === 0) {
      throw new Error("timeframe must not be empty");
    }
    const slug = slugify(label);
    return {
      label,
      slug: slug.length > 0 ? slug : "timeframe",
      providerScope: label,
    };
  }

  if (raw.preset === "custom") {
    if (!isValidIsoDate(raw.start) || !isValidIsoDate(raw.end)) {
      throw new Error(
        `timeframe custom window requires valid ISO calendar dates (YYYY-MM-DD); received start=${raw.start}, end=${raw.end}`,
      );
    }
    if (raw.start > raw.end) {
      throw new Error(`timeframe custom start (${raw.start}) must be on or before end (${raw.end})`);
    }
    return {
      label: `${formatMediumUtc(raw.start)} – ${formatMediumUtc(raw.end)} (custom range)`,
      slug: slugify(`${raw.start}-to-${raw.end}`),
      providerScope: `${raw.start} to ${raw.end} (inclusive calendar dates, UTC)`,
    };
  }

  const today = utcCalendarDate(now);
  const months = PRESET_MONTHS[raw.preset];
  const start = addCalendarMonths(today, -months);
  return {
    label: `${formatMediumUtc(start)} – ${formatMediumUtc(today)} (${PRESET_LABEL[raw.preset]}, rolling)`,
    slug: PRESET_SLUG[raw.preset],
    providerScope: `${start} to ${today} (${PRESET_LABEL[raw.preset]} rolling window; prefer evidence within this interval)`,
  };
}
