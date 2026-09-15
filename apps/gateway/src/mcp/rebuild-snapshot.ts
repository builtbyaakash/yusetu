import { and, eq } from "drizzle-orm";
import { exposedToolName } from "@yusetu/shared";
import { getDb } from "../db/index.js";
import { tools, upstreams } from "../db/schema.js";
import { runtimeSnapshot, type SnapshotTool } from "./snapshot.js";

export function rebuildSnapshotFromDb(): void {
  const db = getDb();
  const rows = db
    .select({
      tool: tools,
      slug: upstreams.slug,
      upstreamEnabled: upstreams.enabled,
    })
    .from(tools)
    .innerJoin(upstreams, eq(tools.upstreamId, upstreams.id))
    .where(and(eq(tools.enabled, true), eq(upstreams.enabled, true)))
    .all();

  const mapped: SnapshotTool[] = rows.map((row) => {
    let inputSchema: Record<string, unknown> | null = null;
    if (row.tool.inputSchemaJson) {
      try {
        inputSchema = JSON.parse(row.tool.inputSchemaJson) as Record<
          string,
          unknown
        >;
      } catch {
        inputSchema = null;
      }
    }
    return {
      upstreamId: row.tool.upstreamId,
      originalName: row.tool.originalName,
      slug: row.slug,
      exposedName: row.tool.exposedName || exposedToolName(row.slug, row.tool.originalName),
      description: row.tool.description,
      inputSchema,
    };
  });

  runtimeSnapshot.swap(mapped);
}
