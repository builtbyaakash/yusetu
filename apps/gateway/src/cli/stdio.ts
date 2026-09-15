/**
 * `yusetu stdio` — MCP stdio bridge that forwards to the HTTP gateway daemon.
 * Keeps a single SQLite writer (the HTTP process) by proxying tools/list + tools/call
 * over Streamable HTTP to http://127.0.0.1:$PORT/mcp.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type ListToolsResult,
} from "@modelcontextprotocol/sdk/types.js";
import { loadConfig, VERSION } from "../config.js";

export async function runStdioBridge(opts?: {
  port?: number;
  apiKey?: string;
}): Promise<void> {
  const config = loadConfig();
  const port = opts?.port ?? config.port;
  const baseUrl = `http://127.0.0.1:${port}/mcp`;

  const headers: Record<string, string> = {};
  const apiKey = opts?.apiKey ?? process.env.YUSETU_API_KEY;
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const httpClient = new Client(
    { name: "yusetu-stdio-bridge", version: VERSION },
    { capabilities: {} },
  );
  const httpTransport = new StreamableHTTPClientTransport(new URL(baseUrl), {
    requestInit: { headers },
  });
  await httpClient.connect(httpTransport);

  const server = new Server(
    { name: "yusetu-stdio", version: VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(
    ListToolsRequestSchema,
    async (): Promise<ListToolsResult> => {
      return httpClient.listTools();
    },
  );

  server.setRequestHandler(
    CallToolRequestSchema,
    async (request): Promise<CallToolResult> => {
      const result = await httpClient.callTool({
        name: request.params.name,
        arguments: request.params.arguments ?? {},
      });
      return result as CallToolResult;
    },
  );

  const stdio = new StdioServerTransport();
  await server.connect(stdio);

  // Keep process alive; StdioServerTransport reads stdin until EOF
  const shutdown = async () => {
    await server.close().catch(() => undefined);
    await httpClient.close().catch(() => undefined);
    await httpTransport.close().catch(() => undefined);
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}
