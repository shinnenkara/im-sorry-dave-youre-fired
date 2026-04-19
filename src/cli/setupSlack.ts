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
const slackMcpDocsUrl = "https://docs.slack.dev/ai/slack-mcp-server/";
const slackAppsDashboardUrl = "https://api.slack.com/apps";
const localCallbackUrl = "http://localhost:3334/oauth/callback";
const slackAgentProjectName = "im-sorry-slack";
const slackAgentProjectPath = resolve(slackAgentProjectName);
const slackAgentTemplate = "slack-samples/bolt-js-starter-agent";
const slackAgentTemplateSubdir = "claude-agent-sdk";

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
      output.write("\nSlack CLI is not installed.\n");
      output.write("Install with:\n");
      output.write("  curl -fsSL https://downloads.slack-edge.com/slack-cli/install.sh | bash\n\n");
      throw new Error("Missing Slack CLI.");
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

async function ensureSlackLogin(rl: ReturnType<typeof createInterface>): Promise<void> {
  try {
    const result = await execa("slack", ["auth", "list"]);
    const normalized = `${result.stdout}\n${result.stderr}`.toLowerCase();
    if (normalized.includes("no authorized") || normalized.includes("not logged in")) {
      output.write("\nSlack CLI is installed but not logged in.\n");
      const answer = (await rl.question("Run `slack login` now? [Y/n]: ")).trim().toLowerCase();
      if (answer === "n") {
        throw new Error("Slack login is required.");
      }
      await execa("slack", ["login"], { stdio: "inherit" });
    } else {
      output.write("Slack CLI login detected.\n");
    }
  } catch {
    output.write("\nCould not verify Slack login automatically.\n");
    const answer = (await rl.question("Run `slack login` now? [Y/n]: ")).trim().toLowerCase();
    if (answer === "n") {
      throw new Error("Slack login is required.");
    }
    await execa("slack", ["login"], { stdio: "inherit" });
  }
}

async function ensureSlackAgentProject(): Promise<void> {
  if (existsSync(slackAgentProjectPath)) {
    output.write(`Using existing Slack agent project: ${slackAgentProjectName}\n`);
    return;
  }
  output.write(`\nCreating Slack agent project: ${slackAgentProjectName}\n`);
  output.write(`Template: ${slackAgentTemplate} (${slackAgentTemplateSubdir})\n`);
  await execa(
    "slack",
    [
      "create",
      slackAgentProjectName,
      "--template",
      slackAgentTemplate,
      "--subdir",
      slackAgentTemplateSubdir,
    ],
    { stdio: "inherit" },
  );
}

interface SlackManifest {
  display_information: {
    name: string;
  };
  features: {
    bot_user: {
      display_name: string;
      always_online: boolean;
    };
  };
  oauth_config: {
    redirect_urls: string[];
    scopes: {
      user: string[];
      bot: string[];
    };
  };
  settings: {
    org_deploy_enabled: boolean;
    socket_mode_enabled: boolean;
    is_hosted: boolean;
    token_rotation_enabled: boolean;
  };
}

interface LinkedSlackApp {
  appId: string;
  teamId?: string;
  teamDomain?: string;
}

async function getLinkedSlackApp(): Promise<LinkedSlackApp | null> {
  const candidatePaths = [
    resolve(slackAgentProjectPath, ".slack", "apps.dev.json"),
    resolve(slackAgentProjectPath, ".slack", "apps.json"),
  ];
  for (const appsPath of candidatePaths) {
    if (!existsSync(appsPath)) {
      continue;
    }
    try {
      const raw = await readFile(appsPath, "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const first = Object.values(parsed)[0];
      if (first && typeof first === "object" && !Array.isArray(first)) {
        const record = first as Record<string, unknown>;
        const appId = typeof record.app_id === "string" ? record.app_id : "";
        if (appId.length > 0) {
          return {
            appId,
            teamId: typeof record.team_id === "string" ? record.team_id : undefined,
            teamDomain: typeof record.team_domain === "string" ? record.team_domain : undefined,
          };
        }
      }
    } catch {
      // Try next candidate path.
    }
  }
  return null;
}

function buildSlackAgentManifest(): SlackManifest {
  return {
    display_information: {
      name: slackAgentProjectName,
    },
    features: {
      bot_user: {
        display_name: slackAgentProjectName,
        always_online: false,
      },
    },
    oauth_config: {
      redirect_urls: [localCallbackUrl],
      scopes: {
        user: [
          "search:read.public",
          "search:read.private",
          "search:read.mpim",
          "search:read.im",
          "search:read.files",
          "search:read.users",
          "channels:history",
          "groups:history",
          "mpim:history",
          "im:history",
          "canvases:read",
          "users:read",
          "users:read.email",
        ],
        bot: ["chat:read"],
      },
    },
    settings: {
      org_deploy_enabled: false,
      socket_mode_enabled: false,
      is_hosted: false,
      token_rotation_enabled: false,
    },
  };
}

async function enforceSlackAgentManifest(): Promise<void> {
  const manifestPath = resolve(slackAgentProjectPath, "manifest.json");
  const manifest = buildSlackAgentManifest();
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  output.write(`Enforced Slack app manifest: ${manifestPath}\n`);
}

async function isSlackAppLinkedToProject(): Promise<boolean> {
  const candidatePaths = [
    resolve(slackAgentProjectPath, ".slack", "apps.dev.json"),
    resolve(slackAgentProjectPath, ".slack", "apps.json"),
  ];
  for (const appsPath of candidatePaths) {
    if (!existsSync(appsPath)) {
      continue;
    }
    try {
      const raw = await readFile(appsPath, "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (Object.keys(parsed).length > 0) {
        return true;
      }
    } catch {
      // keep checking other candidate files
    }
  }
  return false;
}

async function ensureSlackAppInstalled(rl: ReturnType<typeof createInterface>): Promise<void> {
  output.write(`\nSlack app project path: ${slackAgentProjectPath}\n`);
  output.write(`Required redirect URL: ${localCallbackUrl}\n`);
  const linked = await isSlackAppLinkedToProject();
  if (!linked) {
    output.write("\nNo linked Slack app found for this project.\n");
    output.write("Running `slack app install --environment local` now.\n");
    output.write("This installs/links the local app without starting the runtime server.\n\n");
    try {
      await execa("slack", ["app", "install", "--environment", "local"], {
        cwd: slackAgentProjectPath,
        stdio: "inherit",
      });
    } catch (error) {
      const message = extractErrorMessage(error);
      const normalized = message.toLowerCase();
      const isInteractiveTtyIssue = normalized.includes("not a tty") || normalized.includes("prompt_error");
      if (isInteractiveTtyIssue) {
        output.write("\nAutomatic Slack app install requires an interactive TTY.\n");
        output.write(`Run this manually, then return:\n  cd ${slackAgentProjectName} && slack app install --environment local\n`);
        output.write("Waiting for your confirmation...\n");
        await rl.question("Press Enter after manual app install finishes...");
      } else {
        output.write("\n`slack app install` exited unexpectedly.\n");
        output.write(`Details: ${message}\n`);
      }
    }
    output.write("Waiting for your confirmation...\n");
    const installed = (await rl.question("Did you see Slack 'App Install ... Finished' in output? [Y/n]: "))
      .trim()
      .toLowerCase();
    if (installed === "n") {
      output.write("\nPlease run this manually and complete app install:\n");
      output.write(`  cd ${slackAgentProjectName} && slack app install --environment local\n`);
      output.write("When prompted, choose team and Create a new app.\n");
      output.write("Waiting for your confirmation...\n");
      await rl.question("Press Enter after app install finishes...");
    }
  } else {
    output.write("Slack app is already linked to this project.\n");
    const rerun = (await rl.question("Run `slack app install --environment local` to re-sync manifest/install? [y/N]: "))
      .trim()
      .toLowerCase();
    if (rerun === "y") {
      try {
        await execa("slack", ["app", "install", "--environment", "local"], {
          cwd: slackAgentProjectPath,
          stdio: "inherit",
        });
      } catch (error) {
        const message = extractErrorMessage(error);
        const normalized = message.toLowerCase();
        const isInteractiveTtyIssue = normalized.includes("not a tty") || normalized.includes("prompt_error");
        if (isInteractiveTtyIssue) {
          output.write("\nAutomatic re-sync requires an interactive TTY.\n");
          output.write(
            `Run this manually, then return:\n  cd ${slackAgentProjectName} && slack app install --environment local\n`,
          );
          output.write("Waiting for your confirmation...\n");
          await rl.question("Press Enter after manual app install finishes...");
        } else {
          throw error;
        }
      }
    }
  }

  const linkedAfterSetup = await isSlackAppLinkedToProject();
  const linkedApp = await getLinkedSlackApp();
  const appSettingsUrl = linkedApp ? `https://api.slack.com/apps/${linkedApp.appId}` : slackAppsDashboardUrl;
  if (linkedAfterSetup) {
    output.write("\nOpening app settings to copy client_id/client_secret...\n");
    try {
      await execa("slack", ["app", "settings"], { cwd: slackAgentProjectPath, stdio: "inherit" });
    } catch {
      output.write("Could not open via Slack CLI in this terminal context.\n");
      openUrl(appSettingsUrl);
    }
  } else {
    output.write("\nSlack app may be installed but not linked in local config yet.\n");
    output.write("Opening Slack apps dashboard instead.\n");
    openUrl(slackAppsDashboardUrl);
    output.write(`Find app "${slackAgentProjectName}", then copy client_id/client_secret from its settings.\n`);
  }
  output.write(`If browser does not open, use: ${appSettingsUrl}\n`);
  if (linkedApp?.teamDomain) {
    output.write(`Workspace: ${linkedApp.teamDomain}\n`);
  }
  output.write(`Slack MCP docs: ${slackMcpDocsUrl}\n`);
  output.write("\nReminder: this setup command cannot read client_secret automatically from Slack.\n");
  output.write("Waiting for your confirmation...\n");
  await rl.question("Press Enter after opening app settings and copying client_id/client_secret...");
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
    output.write("Slack setup assistant\n");
    output.write("=====================\n");
    await ensureSlackCliInstalled();
    await ensureSlackLogin(rl);
    await ensureSlackAgentProject();
    await enforceSlackAgentManifest();
    await ensureSlackAppInstalled(rl);

    const currentClientId = process.env.SLACK_CLIENT_ID ?? "";
    const currentClientSecret = process.env.SLACK_CLIENT_SECRET ?? "";
    output.write("\nPaste Slack app OAuth credentials from app settings:\n");
    output.write("  - Basic Information -> App Credentials -> Client ID\n");
    output.write("  - Basic Information -> App Credentials -> Client Secret\n");
    output.write(`Required redirect URL in Slack app OAuth settings: ${localCallbackUrl}\n`);

    const clientIdInput = await rl.question(
      `SLACK_CLIENT_ID${currentClientId ? " (press Enter to keep current)" : ""}: `,
    );
    const clientSecretInput = await rl.question(
      `SLACK_CLIENT_SECRET${currentClientSecret ? " (press Enter to keep current)" : ""}: `,
    );

    const clientId = (clientIdInput.trim() || currentClientId).trim();
    const clientSecret = (clientSecretInput.trim() || currentClientSecret).trim();
    if (!clientId || !clientSecret) {
      throw new Error("Both SLACK_CLIENT_ID and SLACK_CLIENT_SECRET are required.");
    }

    await upsertEnvFile({
      SLACK_CLIENT_ID: clientId,
      SLACK_CLIENT_SECRET: clientSecret,
    });
    output.write("\nUpdated .env with Slack credentials.\n");

    await verifySlackMcp(rl, clientId, clientSecret);

    output.write("\nSetup complete.\n");
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
