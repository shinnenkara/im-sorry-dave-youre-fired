import { execa } from "execa";

import { listMcpTools } from "../providers/mcpClient.js";
import { McpServerResolver } from "../providers/mcpServerResolver.js";
import type { McpServerConfig } from "../config/types.js";
import type { ReadinessCheckId } from "./providerWizardMeta.js";

export interface ReadinessResult {
  ok: boolean;
  message: string;
  setupHelp?: string;
}

type ReadinessCheck = () => Promise<ReadinessResult>;

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function checkGeminiSetup(): Promise<ReadinessResult> {
  if (process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
    return {
      ok: true,
      message: "Google AI key found.",
    };
  }
  return {
    ok: false,
    message: "Missing GOOGLE_GENERATIVE_AI_API_KEY.",
    setupHelp: "Set GOOGLE_GENERATIVE_AI_API_KEY before running the review.",
  };
}

async function checkAnthropicSetup(): Promise<ReadinessResult> {
  if (process.env.ANTHROPIC_API_KEY) {
    return {
      ok: true,
      message: "Anthropic API key found.",
    };
  }
  return {
    ok: false,
    message: "Missing ANTHROPIC_API_KEY.",
    setupHelp: "Set ANTHROPIC_API_KEY before running the review with Claude models.",
  };
}

async function checkGithubCliSetup(): Promise<ReadinessResult> {
  try {
    await execa("gh", ["auth", "status"], { all: true });
    return { ok: true, message: "GitHub CLI authentication is ready." };
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      message: `GitHub CLI auth check failed: ${details}`,
      setupHelp: "Run `gh auth login` and verify with `gh auth status`.",
    };
  }
}

async function checkClickupMcpSetup(): Promise<ReadinessResult> {
  const resolver = new McpServerResolver({});
  const server: McpServerConfig = resolver.require("clickup");
  try {
    const tools = await withTimeout(listMcpTools(server), 12_000);
    if (tools.length === 0) {
      return {
        ok: false,
        message: "ClickUp MCP responded but returned no tools.",
        setupHelp: "Review ClickUp MCP configuration and authentication before running.",
      };
    }
    return {
      ok: true,
      message: `ClickUp MCP is reachable (${tools.length} tools detected).`,
    };
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      message: `ClickUp MCP check failed: ${details}`,
      setupHelp: "See README provider notes and ensure ClickUp MCP authentication is complete.",
    };
  }
}

async function checkSlackMcpSetup(): Promise<ReadinessResult> {
  return {
    ok: true,
    message: "Slack interactive setup is available.",
    setupHelp: "You will be prompted for Slack user email.",
  };
}

const checks: Record<ReadinessCheckId, ReadinessCheck> = {
  gemini: checkGeminiSetup,
  anthropic: checkAnthropicSetup,
  "github-cli": checkGithubCliSetup,
  "clickup-mcp": checkClickupMcpSetup,
  "slack-mcp": checkSlackMcpSetup,
};

export async function runReadinessChecks(ids: readonly ReadinessCheckId[]): Promise<Record<ReadinessCheckId, ReadinessResult>> {
  const uniqueIds = [...new Set(ids)];
  const pairs = await Promise.all(
    uniqueIds.map(async (id) => {
      const check = checks[id];
      return [id, await check()] as const;
    }),
  );
  return Object.fromEntries(pairs) as Record<ReadinessCheckId, ReadinessResult>;
}
