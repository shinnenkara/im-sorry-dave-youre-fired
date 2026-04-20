#!/usr/bin/env node
import "dotenv/config";

import { createInterface } from "node:readline/promises";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { stdin as input, stdout as output } from "node:process";
import { spawn } from "node:child_process";

import { execa } from "execa";

import type { McpServerConfig } from "../config/types.js";
import { listMcpTools } from "../providers/mcpClient.js";

const slackMcpUrl = "https://mcp.slack.com/mcp";
const slackMcpDocsUrl = "https://docs.slack.dev/ai/slack-mcp-server/developing";
const slackAppsDashboardUrl = "https://api.slack.com/apps";
const localCallbackUrl = "http://localhost:3334/oauth/callback";
const localTemplatePath = resolve("apps", "templates", "im-sorry-slack-template");
const localAppPath = resolve("apps", "im-sorry-slack");

function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function openUrl(url: string): void {
  const platform = process.platform;
  const command = platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open";
  const args = platform === "darwin" ? [url] : platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.unref();
  } catch {
    // Best effort only.
  }
}

function looksLikeSlackConfigParseError(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("failed to parse contents of system-level config file") ||
    normalized.includes("unable_to_parse_json") ||
    normalized.includes("unexpected end of json input")
  );
}

async function tryRepairSlackConfig(): Promise<boolean> {
  const configPath = join(homedir(), ".slack", "config.json");
  if (!existsSync(configPath)) {
    return false;
  }
  try {
    const current = await readFile(configPath, "utf8");
    const trimmed = current.trim();
    if (trimmed.length === 0) {
      await writeFile(configPath, "{}\n", "utf8");
      output.write(`Repaired empty Slack CLI config: ${configPath}\n`);
      return true;
    }
    try {
      JSON.parse(trimmed);
      return false;
    } catch {
      await writeFile(configPath, "{}\n", "utf8");
      output.write(`Replaced invalid Slack CLI config with defaults: ${configPath}\n`);
      return true;
    }
  } catch {
    return false;
  }
}

async function ensureSlackCliInstalled(): Promise<void> {
  try {
    let result = await execa("slack", ["version"], { reject: false });
    if (result.exitCode !== 0 && looksLikeSlackConfigParseError(`${result.stdout}\n${result.stderr}`)) {
      const repaired = await tryRepairSlackConfig();
      if (repaired) {
        result = await execa("slack", ["version"], { reject: false });
      }
    }
    if (result.exitCode !== 0) {
      const message = `${result.stdout}\n${result.stderr}`.trim();
      if (looksLikeSlackConfigParseError(message)) {
        throw new Error(
          `Slack CLI is installed but local CLI config is invalid. Fix ~/.slack/config.json or run \`slack login\` again. ${message}`,
        );
      }
      throw new Error(message || "Slack CLI exited with a non-zero status.");
    }
    output.write(`${result.stdout.trim()}\n`);
  } catch (error) {
    const message = extractErrorMessage(error);
    if (message.includes("command not found") || message.includes("ENOENT")) {
      throw new Error("No Slack CLI found. Install Slack CLI first, then rerun this setup.");
    }
    throw error;
  }
}

function buildMcpRemoteServer(clientId: string, clientSecret: string): McpServerConfig {
  return {
    command: "npx",
    args: [
      "-y",
      "mcp-remote",
      slackMcpUrl,
      "3334",
      "--host",
      "localhost",
      "--static-oauth-client-info",
      JSON.stringify({ client_id: clientId, client_secret: clientSecret }),
    ],
    env: {
      SLACK_CLIENT_ID: clientId,
      SLACK_CLIENT_SECRET: clientSecret,
    },
  };
}

async function upsertEnvFile(updates: Record<string, string>): Promise<void> {
  const envPath = resolve(".env");
  const existing = existsSync(envPath) ? await readFile(envPath, "utf8") : "";
  const lines = existing.length > 0 ? existing.split(/\r?\n/) : [];
  const indexByKey = new Map<string, number>();

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const match = line?.match(/^([A-Z0-9_]+)=/);
    if (match?.[1]) {
      indexByKey.set(match[1], index);
    }
  }

  for (const [key, value] of Object.entries(updates)) {
    const nextLine = `${key}=${value}`;
    const existingIndex = indexByKey.get(key);
    if (typeof existingIndex === "number") {
      lines[existingIndex] = nextLine;
    } else {
      lines.push(nextLine);
    }
  }

  const next = `${lines.filter((line) => line !== undefined).join("\n").replace(/\n+$/g, "")}\n`;
  await writeFile(envPath, next, "utf8");
}

async function ensureSlackLogin(): Promise<void> {
  const result = await execa("slack", ["auth", "list"], { reject: false });
  const normalized = `${result.stdout}\n${result.stderr}`.toLowerCase();
  const hasNoActiveLogin =
    result.exitCode !== 0 ||
    normalized.includes("no authorized") ||
    normalized.includes("not logged in") ||
    normalized.includes("not authenticated");

  if (hasNoActiveLogin) {
    throw new Error("No active Slack login. Run `slack login` first, then rerun this setup.");
  }

  output.write("Slack CLI login detected.\n");
}

function printSetupGuide(): void {
  output.write("\nOfficial Slack setup steps (docs-first):\n");
  output.write("1) Authenticate Slack CLI:\n");
  output.write("   slack login\n\n");
  output.write("2) Create a new app from this repository template:\n");
  output.write(`   slack create "${localAppPath}" -t "${localTemplatePath}"\n\n`);
  output.write("3) Install/link the app in that generated project:\n");
  output.write(`   cd "${localAppPath}"\n`);
  output.write("   slack app install --environment local\n\n");
  output.write("4) Open app settings:\n");
  output.write("   slack app settings\n");
  output.write("   (or https://api.slack.com/apps/<APP_ID> from install output)\n\n");
  output.write("5) In Slack app settings, ensure:\n");
  output.write(`   - Redirect URL includes: ${localCallbackUrl}\n`);
  output.write("   - Agents & AI Apps -> Model Context Protocol is enabled\n");
  output.write("   - Direct MCP page: https://api.slack.com/apps/<APP_ID>/app-assistant\n");
  output.write("   - Note: MCP toggle cannot be auto-enabled by `slack app install`\n");
  output.write(`   - App settings URL: ${slackAppsDashboardUrl}\n`);
  output.write(`6) Copy SLACK_CLIENT_ID and SLACK_CLIENT_SECRET into ${resolve(".env")}\n\n`);
  output.write(`Template manifest path: ${resolve(localTemplatePath, "manifest.json")}\n`);
  output.write(`Slack MCP docs: ${slackMcpDocsUrl}\n`);
}

async function collectSlackCredentials(rl: ReturnType<typeof createInterface>): Promise<{ clientId: string; clientSecret: string }> {
  const currentClientId = (process.env.SLACK_CLIENT_ID ?? "").trim();
  const currentClientSecret = (process.env.SLACK_CLIENT_SECRET ?? "").trim();
  if (currentClientId.length > 0 && currentClientSecret.length > 0) {
    output.write("\nUsing SLACK_CLIENT_ID / SLACK_CLIENT_SECRET from environment.\n");
    return { clientId: currentClientId, clientSecret: currentClientSecret };
  }

  output.write("\nPaste Slack app OAuth credentials from app settings:\n");
  output.write("  - Basic Information -> App Credentials -> Client ID\n");
  output.write("  - Basic Information -> App Credentials -> Client Secret\n");
  output.write(`  - Required redirect URL in OAuth settings: ${localCallbackUrl}\n`);
  output.write(`  - App settings: ${slackAppsDashboardUrl}\n`);

  const clientIdInput = await rl.question(
    `SLACK_CLIENT_ID${currentClientId ? " (press Enter to keep current)" : ""}: `,
  );
  const clientSecretInput = await rl.question(
    `SLACK_CLIENT_SECRET${currentClientSecret ? " (press Enter to keep current)" : ""}: `,
  );

  const clientId = (clientIdInput.trim() || currentClientId).trim();
  const clientSecret = (clientSecretInput.trim() || currentClientSecret).trim();
  if (!clientId || !clientSecret) {
    throw new Error(
      "Both SLACK_CLIENT_ID and SLACK_CLIENT_SECRET are required. Add them to .env, then rerun `npm run setup:slack`.",
    );
  }

  await upsertEnvFile({
    SLACK_CLIENT_ID: clientId,
    SLACK_CLIENT_SECRET: clientSecret,
  });
  output.write(`Updated ${resolve(".env")} with Slack credentials.\n`);
  return { clientId, clientSecret };
}

async function verifySlackMcp(
  rl: ReturnType<typeof createInterface>,
  clientId: string,
  clientSecret: string,
): Promise<void> {
  const server = buildMcpRemoteServer(clientId, clientSecret);
  let attempts = 0;
  while (attempts < 2) {
    attempts += 1;
    try {
      output.write("\nChecking Slack MCP connection...\n");
      const tools = await listMcpTools(server);
      const searchTools = tools.filter((tool) => tool.includes("search"));
      output.write(`Slack MCP is ready. Found ${tools.length} tools (${searchTools.length} search tools).\n`);
      return;
    } catch (error) {
      const message = extractErrorMessage(error);
      const appAssistantUrl = message.match(/https:\/\/api\.slack\.com\/apps\/[A-Z0-9]+\/app-assistant/i)?.[0];
      if (appAssistantUrl) {
        output.write("\nYour app still needs Slack MCP enabled in App Assistant.\n");
        output.write(`Opening: ${appAssistantUrl}\n`);
        openUrl(appAssistantUrl);
        await rl.question("After enabling MCP there, press Enter to retry...");
        continue;
      }
      if (message.includes("redirect_uri did not match any configured URIs")) {
        output.write("\nSlack app redirect URL mismatch.\n");
        output.write(`Add this exact URL in your Slack app OAuth settings: ${localCallbackUrl}\n`);
        throw new Error(message);
      }
      if (message.toLowerCase().includes("invalid client_id")) {
        output.write("\nSlack rejected the client_id. Check SLACK_CLIENT_ID / SLACK_CLIENT_SECRET.\n");
        throw new Error(message);
      }
      output.write(`\nSlack MCP check failed: ${message}\n`);
      output.write(`Slack MCP docs: ${slackMcpDocsUrl}\n`);
      throw new Error(message);
    }
  }
  throw new Error("Slack MCP was not enabled after retry.");
}

async function main(): Promise<void> {
  const rl = createInterface({ input, output });
  try {
    output.write("Slack MCP verifier\n");
    output.write("==================\n");
    await ensureSlackCliInstalled();
    await ensureSlackLogin();
    printSetupGuide();
    output.write("Complete the steps above first if this is a new setup.\n");
    await rl.question("Press Enter to continue with MCP verification...");

    const { clientId, clientSecret } = await collectSlackCredentials(rl);
    await verifySlackMcp(rl, clientId, clientSecret);

    output.write("\nSlack MCP verification complete.\n");
    output.write("Next run:\n");
    output.write("  npm run dev -- --config configs/slack-test.yaml\n");
  } catch (error) {
    const message = extractErrorMessage(error);
    if (message.includes("Aborted with Ctrl+C")) {
      output.write("\nSetup canceled by user.\n");
      return;
    }
    output.write(`\nSetup failed: ${message}\n`);
    process.exitCode = 1;
  } finally {
    rl.close();
  }
}

await main();
