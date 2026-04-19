import type { McpServerConfig } from "../config/types.js";

const defaultRemoteServers: Record<string, McpServerConfig> = {
  clickup: {
    command: "npx",
    args: ["-y", "mcp-remote", "https://mcp.clickup.com/mcp"],
  },
  slack: {
    command: "npx",
    args: ["-y", "mcp-remote", "https://mcp.slack.com/mcp"],
  },
};

export class McpServerResolver {
  private readonly configuredServers: Record<string, McpServerConfig>;

  public constructor(configuredServers: Record<string, McpServerConfig>) {
    this.configuredServers = configuredServers;
  }

  public require(serverName: string): McpServerConfig {
    const configured = this.configuredServers[serverName];
    if (configured) {
      return configured;
    }
    const fallback = defaultRemoteServers[serverName];
    if (fallback) {
      return fallback;
    }
    throw new Error(`MCP server "${serverName}" is referenced but not defined in mcpServers`);
  }
}
