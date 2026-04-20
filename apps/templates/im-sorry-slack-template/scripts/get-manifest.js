#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const manifestPath = resolve(process.cwd(), "manifest.json");
const manifest = readFileSync(manifestPath, "utf8");
process.stdout.write(manifest);
