# im-sorry-dave-youre-fired

AI-assisted enterprise performance review CLI built with TypeScript, Node.js, AI SDK, MCP, and Ink.

## What it does

1. Loads review config (YAML/JSON).
2. Uses a fast Gemini model to plan provider queries.
3. Pulls evidence from task/comms/code providers in parallel.
4. Uses a pro Gemini model to draft the final review with citations.
5. Writes:
   - `performance_review_<subject>_<timeframe>.md`
   - `performance_review_<subject>_<timeframe>_references.md` (citations used by the review body)
   - `performance_review_<subject>_<timeframe>_stats.md` (deterministic, numbers-only statistics)

## Requirements

- Node.js 20+
- `gh` CLI installed and authenticated (`gh auth status`)
- `GOOGLE_GENERATIVE_AI_API_KEY` in environment
- MCP servers available for configured providers

## Install

```bash
npm install
```

## Run

```bash
npm run dev -- --config configs/review.example.yaml
```

Quick run with interactive setup (no config file):

```bash
npm run dev --
```

The interactive setup asks for:

- display name
- timeframe
- review topics/questions
- model (Gemini preset for now)
- provider selection and provider-specific inputs

Positional config path is also supported:

```bash
npm run dev -- configs/review.example.yaml
```

Build + run:

```bash
npm run build
npm start -- --config configs/review.example.yaml
```

Dry run:

```bash
npm run dev -- --config configs/review.example.yaml --dry-run
```

## Slack setup automation

Run a guided setup for Slack MCP:

```bash
npm run setup:slack
```

The assistant will:

- verify Slack CLI is installed
- verify/trigger `slack login`
- create/reuse a fixed Slack agent project named `im-sorry-slack`
- use a fixed non-interactive template (`slack-samples/bolt-js-starter-agent` / `claude-agent-sdk`)
- enforce a manifest with MCP-ready OAuth redirect/scopes
- run/open Slack app setup (`slack app install --environment local`, `slack app settings`) when needed
- save `SLACK_CLIENT_ID` and `SLACK_CLIENT_SECRET` into `.env`
- validate Slack MCP connectivity with your current credentials
- if needed, open your app's Slack MCP App Assistant page and retry automatically

During first app install, Slack CLI may still ask one interactive prompt (`Create a new app`).

Notes:

- Slack app OAuth must include redirect URL `http://localhost:3334/oauth/callback`.
- This setup is usually one-time per machine/workspace unless credentials are rotated.
- Slack MCP access and approvals depend on workspace policy/plan; many company workspaces are compatible, but admins may still need to approve app access.

## Config

Use [`configs/review.example.yaml`](configs/review.example.yaml) as a template.
Use [`configs/review.defaults.yaml`](configs/review.defaults.yaml) to see default values for optional fields.

Provider notes:

- `tasks` and `comms` providers use MCP stdio servers.
- Each MCP adapter needs a `server` key referencing `mcpServers.<name>`.
- If `mcpServers.clickup` or `mcpServers.slack` is omitted, the CLI falls back to official remote MCP endpoints via `npx -y mcp-remote`.
- Tool names are adapter-specific (`tools.search` in the sample).
- ClickUp MCP authentication is OAuth-only; do not configure ClickUp API keys in `mcpServers.clickup.env`.
- Slack MCP authentication is OAuth-only; do not configure Slack bot/user tokens in this app config.
- `subject` only needs a human-readable `displayName`; Slack/ClickUp identity is resolved via MCP at runtime.
- `providers.tasks.debugOutputPath` and `providers.comms.debugOutputPath` can persist raw provider responses for debugging.
- `providers.comms.expectedWorkspace`, `expectedUserId`, and `expectedUserEmail` can enforce Slack identity/workspace and fail fast on mismatched OAuth sessions.
- `code` provider uses `gh search prs`.
- Interactive setup currently supports `code=GitHub` and `tasks=ClickUp`; `comms=Slack` stays unavailable there for now.
- Interactive setup runs readiness checks before provider selection:
  - Gemini model: requires `GOOGLE_GENERATIVE_AI_API_KEY`
  - GitHub: requires `gh auth status` to pass
  - ClickUp: checks ClickUp MCP tool discovery

## GitHub permissions

For private repos/org visibility, ensure `gh` token has at least:

- `repo`
- `read:org`

Check current auth scopes with:

```bash
gh auth status -t
```

## Sensitive data

Generated review output may include employee-sensitive data. Store and share outputs according to your HR/data retention policies.
