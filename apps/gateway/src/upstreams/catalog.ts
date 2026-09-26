import { and, eq, or } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { upstreams } from "../db/schema.js";
import { runtimeSnapshot, type SnapshotTool } from "../mcp/snapshot.js";

export function poolClientKey(userId: string, upstreamId: string): string {
  return `${userId}:${upstreamId}`;
}

/** Enabled shared upstreams plus this user's enabled personal upstreams. */
export function visibleUpstreamIdsForUser(userId: string): Set<string> {
  const db = getDb();
  const rows = db
    .select({ id: upstreams.id })
    .from(upstreams)
    .where(
      and(
        eq(upstreams.enabled, true),
        or(
          eq(upstreams.visibility, "shared"),
          eq(upstreams.ownerUserId, userId),
        ),
      ),
    )
    .all();
  return new Set(rows.map((r) => r.id));
}

export function catalogToolsForUser(userId: string): SnapshotTool[] {
  const allowed = visibleUpstreamIdsForUser(userId);
  return runtimeSnapshot.list().filter((t) => allowed.has(t.upstreamId));
}

export function isCatalogToolVisible(
  userId: string,
  tool: SnapshotTool | undefined,
): tool is SnapshotTool {
  if (!tool) return false;
  return visibleUpstreamIdsForUser(userId).has(tool.upstreamId);
}
