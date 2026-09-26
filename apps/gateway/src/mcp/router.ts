import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { eq } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { upstreams } from "../db/schema.js";
import { formatToolArgs, getLogger } from "../logger.js";
import { runtimeSnapshot } from "../mcp/snapshot.js";
import { isCatalogToolVisible } from "../upstreams/catalog.js";
import type { UpstreamPool } from "../upstreams/pool.js";

export class ToolRouter {
  constructor(private readonly pool: UpstreamPool) {}

  async callTool(
    userId: string,
    exposedName: string,
    args: Record<string, unknown>,
  ): Promise<CallToolResult> {
    const log = getLogger("data");
    const started = Date.now();
    const meta = runtimeSnapshot.get(exposedName);
    if (!isCatalogToolVisible(userId, meta)) {
      log.warn({ tool: exposedName, userId }, "tool not found or disabled");
      return {
        content: [
          {
            type: "text",
            text: `Unknown or disabled tool: ${exposedName}`,
          },
        ],
        isError: true,
      };
    }

    try {
      const client = await this.pool.getClient(userId, meta.upstreamId);
      const timeoutMs =
        getDb()
          .select({ timeoutMs: upstreams.timeoutMs })
          .from(upstreams)
          .where(eq(upstreams.id, meta.upstreamId))
          .get()?.timeoutMs ?? 30_000;

      const result = await client.callTool(
        {
          name: meta.originalName,
          arguments: args,
        },
        undefined,
        { timeout: timeoutMs },
      );

      log.info(
        {
          tool: exposedName,
          upstreamId: meta.upstreamId,
          userId,
          latencyMs: Date.now() - started,
          args: formatToolArgs(args),
        },
        "tool call",
      );

      return result as CallToolResult;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(
        {
          tool: exposedName,
          upstreamId: meta.upstreamId,
          userId,
          latencyMs: Date.now() - started,
          err: message,
          args: formatToolArgs(args),
        },
        "tool call failed",
      );
      return {
        content: [{ type: "text", text: message }],
        isError: true,
      };
    }
  }
}
