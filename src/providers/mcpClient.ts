import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import type { McpServerConfig } from "../config/types.js";

export class McpToolError extends Error {
  public readonly causeError: unknown;

  public constructor(message: string, causeError: unknown) {
    super(message);
    this.name = "McpToolError";
    this.causeError = causeError;
  }
}

function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

const MCP_CALL_MAX_ATTEMPTS = 3;
const MCP_CALL_BASE_BACKOFF_MS = 500;
const MCP_CALL_TIMEOUT_MS = Number.parseInt(process.env.MCP_CALL_TIMEOUT_MS ?? "", 10);
const MCP_CALL_TIMEOUT_FALLBACK_MS = 45000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function resolveCallTimeoutMs(): number {
  if (Number.isInteger(MCP_CALL_TIMEOUT_MS) && MCP_CALL_TIMEOUT_MS > 0) {
    return MCP_CALL_TIMEOUT_MS;
  }
  return MCP_CALL_TIMEOUT_FALLBACK_MS;
}

function runWithTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    void promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function isRetryableMcpError(error: unknown): boolean {
  const message = formatUnknownError(error).toLowerCase();
  return [
    "429",
    "rate limit",
    "too many requests",
    "connection closed",
    "econnreset",
    "econnrefused",
    "socket hang up",
    "timed out",
    "timeout",
    "eof",
    "broken pipe",
    "epipe",
  ].some((token) => message.includes(token));
}

function extractTextChunks(
  result: {
    content: Array<
      | { type: "text"; text: string }
      | { type: "resource"; resource: { text?: string } }
      | { type: string }
    >;
  },
): string[] {
  const chunks: string[] = [];

  for (const item of result.content) {
    if (item.type === "text" && "text" in item) {
      chunks.push(item.text);
    } else if (item.type === "resource" && "resource" in item && item.resource.text) {
      chunks.push(item.resource.text);
    }
  }

  return chunks;
}

export async function callMcpTool(
  server: McpServerConfig,
  toolName: string,
  args: Record<string, unknown>,
): Promise<string[]> {
  let lastError: unknown;
  const callTimeoutMs = resolveCallTimeoutMs();

  for (let attempt = 1; attempt <= MCP_CALL_MAX_ATTEMPTS; attempt += 1) {
    const client = new Client(
      {
        name: "im-sorry-dave-youre-fired",
        version: "1.0.0",
      },
      {
        capabilities: {},
      },
    );
    const transport = new StdioClientTransport({
      command: server.command,
      args: server.args,
      env: server.env,
      cwd: server.cwd,
      stderr: "pipe",
    });

    try {
      await runWithTimeout(client.connect(transport), callTimeoutMs, `MCP connect (${server.command})`);
      const result = (await runWithTimeout(
        client.callTool({
          name: toolName,
          arguments: args,
        }),
        callTimeoutMs,
        `MCP tool "${toolName}"`,
      )) as {
        content: Array<
          | { type: "text"; text: string }
          | { type: "resource"; resource: { text?: string } }
          | { type: string }
        >;
      };
      return extractTextChunks(result);
    } catch (error) {
      lastError = error;
      const shouldRetry = attempt < MCP_CALL_MAX_ATTEMPTS && isRetryableMcpError(error);
      if (!shouldRetry) {
        const details = formatUnknownError(error);
        throw new McpToolError(
          `MCP tool call failed for "${toolName}" with command "${server.command}" (attempt ${attempt}/${MCP_CALL_MAX_ATTEMPTS}, timeout ${callTimeoutMs}ms): ${details}`,
          error,
        );
      }
      const delayMs = MCP_CALL_BASE_BACKOFF_MS * 2 ** (attempt - 1);
      await sleep(delayMs);
    } finally {
      await transport.close().catch(() => undefined);
      await client.close().catch(() => undefined);
    }
  }

  const details = formatUnknownError(lastError);
  throw new McpToolError(
    `MCP tool call failed for "${toolName}" with command "${server.command}" after ${MCP_CALL_MAX_ATTEMPTS} attempts: ${details}`,
    lastError,
  );
}

export async function listMcpTools(server: McpServerConfig): Promise<string[]> {
  const client = new Client(
    {
      name: "im-sorry-dave-youre-fired",
      version: "1.0.0",
    },
    {
      capabilities: {},
    },
  );
  const transport = new StdioClientTransport({
    command: server.command,
    args: server.args,
    env: server.env,
    cwd: server.cwd,
    stderr: "pipe",
  });

  try {
    const callTimeoutMs = resolveCallTimeoutMs();
    await runWithTimeout(client.connect(transport), callTimeoutMs, `MCP connect (${server.command})`);
    const result = (await runWithTimeout(client.listTools(), callTimeoutMs, `MCP list tools (${server.command})`)) as {
      tools: Array<{ name: string }>;
    };
    return result.tools.map((tool) => tool.name);
  } catch (error) {
    const details = formatUnknownError(error);
    throw new McpToolError(`Failed to list MCP tools for command "${server.command}": ${details}`, error);
  } finally {
    await transport.close().catch(() => undefined);
    await client.close().catch(() => undefined);
  }
}
