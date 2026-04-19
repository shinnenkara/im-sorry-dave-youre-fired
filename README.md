# I'm Sorry Dave, You're Fired (Or Promoted? Let the AI decide)

Let's be honest: nobody likes writing end-of-year enterprise performance reviews. You spend all year shipping code, then suddenly need to remember how many tickets you closed in March and write an essay about your "synergistic impact."

This CLI tool fixes that. Plug in your data sources, paste your HR department's assessment questions, and add a few notable project titles. Then watch your API tokens turn into a beautifully cited, data-backed performance review.

## The Magic ✨

Sure, we could let an LLM hallucinate the whole thing. Management might not notice. You might not notice. Nobody remembers Q2 anyway.

But where is the fun in that? This project actually reviews your real work so the output is grounded in evidence and surprisingly useful.

Run the interactive wizard and it generates:

- `performance_review_<subject>_<timeframe>.md` (the masterpiece)
- `performance_review_<subject>_<timeframe>_references.md` (the receipts and citations)
- `performance_review_<subject>_<timeframe>_stats.md` (hard numbers like LoC and tickets closed)

## Privacy First 🔒

Your data is yours. API keys, tokens, and OAuth sessions are stored locally on your machine. The project is open source so you can verify exactly what happens with your HR-sensitive data.

## The "Holy Trinity" of Data Providers

To write a bulletproof review, the AI gathers context from three pillars of enterprise life:

- **Code (The _Big Bang Theory_ realm / GitHub):** proves what you actually built and merged.
- **Tasks (The _Office Space_ realm / ClickUp):** proves what business value you delivered.
- **Comms (The _Silicon Valley_ realm / Slack - Beta):** proves that you (or your automated AI agent) actually talk to your team.

---

## Quick Start

Requirements:

- Node.js 20+
- `gh` CLI installed and authenticated (`gh auth status`)
- `GOOGLE_GENERATIVE_AI_API_KEY` set in your environment

Install dependencies:

```bash
npm install
```

Start interactive setup (no config file required):

```bash
npm run dev --
```

Run with explicit config:

```bash
npm run dev -- --config configs/review.example.yaml
```

Build and run:

```bash
npm run build
npm start -- --config configs/review.example.yaml
```

## Models Supported 🧠

- **Gemini:** available now (`GOOGLE_GENERATIVE_AI_API_KEY` required)
- **Claude:** coming soon
- **OpenAI:** coming soon

## Provider Setup Guide

This part is dry but necessary so the AI can read your data.

### 1) GitHub (Code)

This project uses the official GitHub CLI to search PRs and commits.

- Install `gh`: [GitHub CLI install guide](https://cli.github.com/)
- Authenticate locally: `gh auth login`
- For private repos, ensure token scopes include at least `repo` and `read:org`
- Check current auth scopes: `gh auth status -t`

### 2) ClickUp (Tasks)

The ClickUp provider authenticates via OAuth in your browser.

- Run the setup wizard and follow prompts
- Make sure you are logged into your company ClickUp account in that browser

### 3) Slack (Comms - Beta)

Slack setup is more involved, so there is an assistant script:

```bash
npm run setup:slack
```

The setup assistant will:

- verify Slack CLI is installed and you are logged in (`slack login`)
- create a fixed Slack agent project on your machine (`im-sorry-slack`)
- open Slack app setup (`slack app install --environment local`) when needed
- save `SLACK_CLIENT_ID` and `SLACK_CLIENT_SECRET` into your local `.env`
- validate Slack MCP connectivity

Note: Slack MCP access depends on workspace policy. Admin approval may be required.

## Config Files

- Use `configs/review.example.yaml` as your starting template
- See `configs/review.defaults.yaml` for optional defaults

## Contributing

Want Jira support? GitLab? Microsoft Teams? Open a PR.

Adding a new provider or model is a great first issue, and your coworkers will thank you.

## Disclaimer

Review the AI output before sending it to your boss so you do not accidentally brag about a production outage.
