#!/usr/bin/env node

import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { stdout as output } from "node:process";

function removeEnvKey(content: string, key: string): string {
  return content
    .split(/\r?\n/)
    .filter((line) => !line.startsWith(`${key}=`))
    .join("\n");
}

async function cleanMcpAuthCache(): Promise<void> {
  const authPath = join(homedir(), ".mcp-auth");
  if (!existsSync(authPath)) {
    output.write(`No MCP auth cache found at ${authPath}\n`);
    return;
  }
  await rm(authPath, { recursive: true, force: true });
  output.write(`Removed MCP auth cache: ${authPath}\n`);
}

async function pruneSlackEnv(): Promise<void> {
  const envPath = resolve(".env");
  if (!existsSync(envPath)) {
    output.write(`No .env file found at ${envPath}\n`);
    return;
  }

  const current = await readFile(envPath, "utf8");
  const withoutClientId = removeEnvKey(current, "SLACK_CLIENT_ID");
  const withoutSlackKeys = removeEnvKey(withoutClientId, "SLACK_CLIENT_SECRET");
  const pruned = withoutSlackKeys.replace(/\r?\n/g, "\n").replace(/\n+$/g, "");
  await writeFile(envPath, `${pruned}\n`, "utf8");
  output.write(`Removed SLACK_CLIENT_ID / SLACK_CLIENT_SECRET from ${envPath}\n`);
}

async function main(): Promise<void> {
  const shouldPruneEnv = process.argv.includes("--prune-env");
  await cleanMcpAuthCache();
  if (shouldPruneEnv) {
    await pruneSlackEnv();
  }

  output.write("\nSlack cleanup checklist:\n");
  output.write("- Uninstall/delete your test app in https://api.slack.com/apps\n");
  output.write("- Remove old Slack app folders created via `slack create` if no longer needed\n");
  output.write("- Re-run `slack login` and setup flow when switching workspaces\n");
  if (!shouldPruneEnv) {
    output.write("- Optional: re-run with `npm run clean:slack -- --prune-env` to remove Slack keys from .env\n");
  }
}

await main();
