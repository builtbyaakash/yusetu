import { randomUUID } from "node:crypto";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { Context } from "hono";
import type { ToolPresentation } from "../config.js";
import { getLogger } from "../logger.js";
import { createFacadeServer } from "./facade.js";
import type { ToolRouter } from "./router.js";
import type { UpstreamPool } from "../upstreams/pool.js";

type SessionEntry = {
  transport: WebStandardStreamableHTTPServerTransport;
  server: Server;
};

/**
 * Streamable HTTP MCP endpoint at /mcp.
 * Legacy SSE (/sse) is not mounted — prefer Streamable HTTP (protocol 2025-03-26+).
 */
export function createMcpHttpHandler(
  router: ToolRouter,
  pool: UpstreamPool,
  presentation: ToolPresentation,
  inlineTinyMcps = false,
  schemaCompression = true,
) {
  const sessions = new Map<string, SessionEntry>();
  const log = getLogger("data");

  const newServer = () =>
    createFacadeServer(
      router,
      pool,
      presentation,
      inlineTinyMcps,
      schemaCompression,
    );

  return async (c: Context): Promise<Response> => {
    const sessionId = c.req.header("mcp-session-id") ?? undefined;

    if (sessionId && sessions.has(sessionId)) {
      const entry = sessions.get(sessionId)!;
      return entry.transport.handleRequest(c.req.raw);
    }

    if (sessionId && !sessions.has(sessionId)) {
      return c.json(
        {
          jsonrpc: "2.0",
          error: { code: -32001, message: "Session not found" },
          id: null,
        },
        404,
      );
    }

    let body: unknown;
    try {
      if (c.req.method === "POST") {
        body = await c.req.json();
      }
    } catch {
      body = undefined;
    }

    if (c.req.method === "POST" && body && isInitializeRequest(body)) {
      const server = newServer();
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: (id) => {
          sessions.set(id, { transport, server });
          log.info(
            { sessionId: id, toolPresentation: presentation },
            "mcp session initialized",
          );
        },
        onsessionclosed: (id) => {
          sessions.delete(id);
          log.info({ sessionId: id }, "mcp session closed");
        },
      });

      transport.onclose = () => {
        const id = transport.sessionId;
        if (id) sessions.delete(id);
      };

      await server.connect(transport);
      return transport.handleRequest(c.req.raw, { parsedBody: body });
    }

    if (c.req.method === "POST") {
      const server = newServer();
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      await server.connect(transport);
      try {
        return await transport.handleRequest(c.req.raw, { parsedBody: body });
      } finally {
        await transport.close().catch(() => undefined);
        await server.close().catch(() => undefined);
      }
    }

    return c.json(
      {
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Bad Request: missing session or initialize",
        },
        id: null,
      },
      400,
    );
  };
}
