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

> _The Honest Disclaimer: Yes, the script does send your gathered data to your chosen AI model (Gemini/Claude/OpenAI) to write the review. But let's be real—you've been pasting your company's proprietary code into ChatGPT since 2022 to fix your regex, so that ship has already sailed. At least this time, it might get you a raise._

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

- Set `ANTHROPIC_API_KEY` in your environment.
- Interactive mode provides a Claude preset:
  - fast planning: `claude-haiku-4-5-20251001`
  - pro synthesis: `claude-sonnet-4-6`

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
- In config, `providers.code.org` optionally scopes searches to a company org (for example `acme`).
- In config, `providers.code.repo` is optional and treated as a preferred list for ranking, not a strict filter.

### ClickUp (Tasks)

The ClickUp provider authenticates via OAuth in your browser.

- Run the setup wizard and follow prompts
- Make sure you are logged into your company ClickUp account in that browser

### Slack (Comms - Beta)

Use official Slack CLI steps first, then run this repo's verifier.

1. Install Slack CLI and log in

```bash
slack login
```

2. From this repository root, create your Slack app from the in-repo template

```bash
slack create im-sorry-slack -t "$(pwd)/templates/im-sorry-slack-template"
```

3. Install/link the app in the generated project

```bash
cd im-sorry-slack
slack app install --environment local
```

4. Open app settings (from `im-sorry-slack` directory):

```bash
slack app settings
```

If CLI cannot open the browser, use:

- `https://api.slack.com/apps/<APP_ID>`
- You can copy `<APP_ID>` from the `slack app install --environment local` output.

5. In app settings, make sure:

- OAuth Redirect URLs include `http://localhost:3334/oauth/callback`
- Under **Agents & AI Apps**, **Model Context Protocol** is enabled
  - direct page: `https://api.slack.com/apps/<APP_ID>/app-assistant`
  - this MCP toggle is currently a Slack-side setting and is not automatically enabled by `slack app install`
- You copy `client_id` and `client_secret` from **Basic Information** -> **App Credentials**

6. Set local environment values in this repo's `.env`:

```bash
SLACK_CLIENT_ID=your_client_id
SLACK_CLIENT_SECRET=your_client_secret
```

7. Run the verifier script (required):

```bash
npm run setup:slack
```

The verifier will:

- verify Slack CLI is installed and your login is active
- trigger the Slack OAuth consent flow in your browser (this is where you connect the app to your workspace/user)
- confirm Slack MCP connectivity with your configured app credentials
- retry with guidance if MCP is not enabled yet for your app

8. Naming and multi-user notes:

- Multiple developers can use the same app name (`im-sorry-slack`) without collisions in practice, because each install is tracked by app ID/environment/workspace.
- `--environment local` keeps this as a development install (`im-sorry-slack (local)`), separate from deployed/production environment.
- If your workspace has many test apps with the same name, rely on `App ID` from install output and open settings with:
  - `slack app settings`
  - or `https://api.slack.com/apps/<APP_ID>`

Note: Slack MCP is available on Slack Pro and higher plans. Access may also depend on workspace policy, and admin approval may be required.

References:

- [Slack MCP setup guide](https://docs.slack.dev/ai/slack-mcp-server/developing)
- [Slack MCP sample app](https://github.com/slack-samples/bolt-js-slack-mcp-server)
- [Slack scopes reference](https://docs.slack.dev/reference/scopes)
- [Slack CLI docs](https://docs.slack.dev/tools/slack-cli/)

#### Cleanup / Teardown (Slack MCP)

When you need to reset local Slack MCP state:

1. Remove cached MCP OAuth tokens

```bash
npm run clean:mcp-auth
```

2. Remove Slack credentials from this repo's `.env` (`SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`).
3. Uninstall or delete the test app in Slack:
   - Open [https://api.slack.com/apps](https://api.slack.com/apps)
   - Select the app you created
   - Use workspace uninstall/delete options, or equivalent Slack CLI commands (`slack app uninstall`, `slack app delete`)

Optional helper:

```bash
npm run clean:slack
```

This helper runs local cleanup and prints a teardown checklist. It does not remove your Slack app from the workspace.

## Contributing

Want Jira support? GitLab? Microsoft Teams? Open a PR.

Adding a new provider or model is a great first issue, and your coworkers may thank you.

## Disclaimer (!)

Review the AI output before sending it to your boss so you do not accidentally brag about a production outage!
