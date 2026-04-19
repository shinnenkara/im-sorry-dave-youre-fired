#!/usr/bin/env node
import "dotenv/config";
import React from "react";
import { Command } from "commander";
import { render } from "ink";

import { runInteractiveSetup } from "./wizard/runInteractiveSetup.js";
import { loadReviewConfig } from "../config/schema.js";
import type { ReviewConfig } from "../config/types.js";
import { App } from "../ui/App.js";

interface CliOptions {
  config?: string;
  dryRun?: boolean;
}

function isPromptCancellationError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  if (error.name === "ExitPromptError") {
    return true;
  }
  return error.message.includes("SIGINT") || error.message === "Interactive setup cancelled.";
}

const program = new Command();

program
  .name("review")
  .description("Generate AI-assisted enterprise performance reviews")
  .argument("[configPath]", "Path to review config file (yaml/json)")
  .option("-c, --config <path>", "Path to review config file (yaml/json)")
  .option("--dry-run", "Run planner and providers without synthesis/output")
  .parse(process.argv);

const options = program.opts<CliOptions>();
const argumentConfigPath = program.args[0];
const configPath = options.config ?? argumentConfigPath;
let config: ReviewConfig;
try {
  config =
    typeof configPath === "string" && configPath.length > 0
      ? await loadReviewConfig(configPath)
      : await runInteractiveSetup();
} catch (error) {
  if (isPromptCancellationError(error)) {
    void process.stderr.write("Interactive setup cancelled.\n");
    process.exit(0);
  }
  throw error;
}

const instance = render(
  React.createElement(App, {
    config,
    dryRun: Boolean(options.dryRun),
  }),
);

await instance.waitUntilExit();
