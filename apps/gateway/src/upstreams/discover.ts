import { and, eq } from "drizzle-orm";
import { exposedToolName } from "@yusetu/shared";
import { getDb } from "../db/index.js";
import { tools, upstreams } from "../db/schema.js";
import { getLogger } from "../logger.js";
import { rebuildSnapshotFromDb } from "../mcp/rebuild-snapshot.js";
import type { UpstreamPool } from "./pool.js";

export type DiscoverResult = {
  discovered: number;
  upserted: number;
  tools: Array<{ originalName: string; exposedName: string }>;
};

export async function discoverUpstreamTools(
  upstreamId: string,
  userId: string,
  pool: UpstreamPool,
): Promise<DiscoverResult> {
  const log = getLogger("control", { upstreamId });
  const db = getDb();
  const upstream = db
    .select()
    .from(upstreams)
    .where(eq(upstreams.id, upstreamId))
    .get();

  if (!upstream) {
    throw new Error("Upstream not found");
  }

  await pool.invalidate(userId, upstreamId);
  const client = await pool.getClient(userId, upstreamId);
  const listed = await client.listTools();
  const now = new Date();
  let upserted = 0;
  const resultTools: DiscoverResult["tools"] = [];

  for (const tool of listed.tools) {
    const exposed = exposedToolName(upstream.slug, tool.name);
    const existing = db
      .select()
      .from(tools)
      .where(
        and(eq(tools.upstreamId, upstreamId), eq(tools.originalName, tool.name)),
      )
      .get();

    const inputSchemaJson = tool.inputSchema
      ? JSON.stringify(tool.inputSchema)
      : null;

    if (existing) {
      db.update(tools)
        .set({
          exposedName: exposed,
          description: tool.description ?? null,
          inputSchemaJson,
          lastSeenAt: now,
        })
        .where(eq(tools.id, existing.id))
        .run();
    } else {
      db.insert(tools)
        .values({
          id: crypto.randomUUID(),
          upstreamId,
          originalName: tool.name,
          exposedName: exposed,
          description: tool.description ?? null,
          inputSchemaJson,
          enabled: true,
          lastSeenAt: now,
        })
        .run();
    }
    upserted += 1;
    resultTools.push({ originalName: tool.name, exposedName: exposed });
  }

  rebuildSnapshotFromDb();
  log.info(
    { discovered: listed.tools.length, upserted, slug: upstream.slug },
    "upstream tools discovered",
  );

  return {
    discovered: listed.tools.length,
    upserted,
    tools: resultTools,
  };
}
