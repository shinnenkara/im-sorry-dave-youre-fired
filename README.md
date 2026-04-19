# I'm Sorry Dave, You're Fired (Or Promoted?)

Let's be honest: nobody likes writing end-of-year enterprise performance reviews. You spend all year shipping code, then suddenly need to remember how many tickets you closed in March and write an essay about your "synergistic impact."

This CLI tool fixes that. Plug in your data sources, paste your HR department's assessment questions, and add a few notable project titles. Then watch your API tokens turn into a beautifully cited, data-backed performance review.

## The Magic ✨

Sure, we could let an LLM hallucinate the whole thing. Management might not notice. You might not notice. Nobody remembers Q2 anyway.

But where is the fun in that? This project actually reviews your real work so the output is grounded in evidence and surprisingly useful.

Run the interactive wizard and it generates:

- `performance_review_<subject>_<timeframe>.md` (the masterpiece)
- `performance_review_<subject>_<timeframe>_references.md` (the receipts and citations)

## Privacy First

Your data is yours. No third-party SaaS servers, no shady org-wide GitHub app installations, and no leaking your proprietary code to a random web form. All API keys and OAuth sessions are stored strictly locally.

> _The Honest Disclaimer: Yes, the script does send your gathered data to your chosen AI model (Gemini/OpenAI) to write the review. But let's be real—you've been pasting your company's proprietary code into ChatGPT since 2022 to fix your regex, so that ship has already sailed. At least this time, it might get you a raise._

## The "Holy Trinity" of Data Providers

To write a bulletproof review, the AI gathers context from three pillars of enterprise life:

- **Code (GitHub):** proves what you actually built and merged.
> I'm not crazy, my commit history had me tested.
- **Tasks (ClickUp):** proves what business value you delivered.
> Did you get the memo about the new Jira workflow?
- **Comms (Slack - Beta):** proves that you (or your automated AI agent) actually talk to your team.
> We need to talk about the middle-out compression of your daily standup updates.

---

## Quick Start

Requirements:

- Node.js 20+
- Set up your model first so the AI can generate your review: [Models Supported](#models-supported)
- Set up your providers, based on what you want to include: [Providers](#providers)

Install dependencies:

```bash
npm install
```

Start interactive setup:

```bash
npm run dev
```

Or build and run:

```bash
npm run build
npm start
```

## Models Supported

### Gemini

#### Setup required

- Set `GOOGLE_GENERATIVE_AI_API_KEY` in your environment.
- Use a paid Google setup (not free tier); free projects currently route to flash-lite models only, which are out of scope for this tool.

### Claude

#### Setup required

- Coming soon.

### OpenAI

#### Setup required

- Coming soon.

## Providers

This part is dry but necessary so the AI can read your data.

### GitHub (Code)

This project uses the official GitHub CLI to search PRs and commits.

- Install `gh`: [GitHub CLI install guide](https://cli.github.com/)
- Authenticate locally: `gh auth login`
- For private repos, ensure token scopes include at least `repo` and `read:org`
- Check current auth scopes: `gh auth status -t`

### ClickUp (Tasks)

The ClickUp provider authenticates via OAuth in your browser.

- Run the setup wizard and follow prompts
- Make sure you are logged into your company ClickUp account in that browser

### Slack (Comms - Beta)

Then keep setup simple:

1. Install Slack CLI (manual step, same idea as GitHub CLI setup)
2. Log in: `slack login`
   - log into the Slack workspace you want this tool to read from
   - Slack CLI will print a command/message to paste in Slack chat
   - you can paste it into any chat, including a DM with yourself
   - Slack will return a code; paste that code back into the CLI to complete login
   - if install/login errors happen, use official documentation as a reference: [Slack agent quickstart](https://docs.slack.dev/ai/agent-quickstart)
3. Run the setup assistant:

```bash
npm run setup:slack
```

The setup assistant will:

- verify Slack CLI is installed and your login is active
- create a fixed Slack agent project on your machine (`im-sorry-slack`)
- open Slack app setup (`slack app install --environment local`) when needed
- save `SLACK_CLIENT_ID` and `SLACK_CLIENT_SECRET` into your local `.env`
- validate Slack MCP connectivity

Note: Slack MCP is available on Slack Pro and higher plans. Access may also depend on workspace policy, and admin approval may be required.

## Contributing

Want Jira support? GitLab? Microsoft Teams? Open a PR.

Adding a new provider or model is a great first issue, and your coworkers may thank you.

## Disclaimer (!)

Review the AI output before sending it to your boss so you do not accidentally brag about a production outage!
