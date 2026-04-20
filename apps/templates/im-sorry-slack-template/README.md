# im-sorry-slack-template

Template manifest for Slack MCP setup in this repository.

Use this manifest with Slack CLI or copy it into Slack app settings:

- Slack CLI template flow: `slack create <your-project-name> -t <template-ref>`
- Slack web flow: `https://api.slack.com/apps` -> **Create New App** -> **From a manifest**

Required redirect URL:

- `http://localhost:3334/oauth/callback`

This manifest is intentionally read-first for user scopes and targets Slack MCP usage with `mcp-remote`.
