import { and, eq, or } from "drizzle-orm";
import { isElevatedRole, parseRole } from "../auth/context.js";
import { getDb } from "../db/index.js";
import { upstreamGrants, upstreams, users, type Upstream } from "../db/schema.js";
import { runtimeSnapshot, type SnapshotTool } from "../mcp/snapshot.js";

export function poolClientKey(userId: string, upstreamId: string): string {
  return `${userId}:${upstreamId}`;
}

function roleForUser(userId: string) {
  const row = getDb()
    .select({ role: users.role })
    .from(users)
    .where(eq(users.id, userId))
    .get();
  return parseRole(row?.role);
}

function hasUpstreamGrant(userId: string, upstreamId: string): boolean {
  return !!getDb()
    .select({ id: upstreamGrants.id })
    .from(upstreamGrants)
    .where(
      and(
        eq(upstreamGrants.userId, userId),
        eq(upstreamGrants.upstreamId, upstreamId),
      ),
    )
    .get();
}

/**
 * Shared is grant-gated. Personal is owner-only.
 * Owner and admin bypass grants for shared. Members need a grant row.
 */
export function canReadUpstreamRow(
  row: Pick<Upstream, "id" | "visibility" | "ownerUserId" | "enabled">,
  userId: string,
  opts: { requireEnabled?: boolean } = {},
): boolean {
  if (opts.requireEnabled && !row.enabled) return false;
  if (row.visibility === "personal") {
    return row.ownerUserId === userId;
  }
  if (isElevatedRole(roleForUser(userId))) return true;
  return hasUpstreamGrant(userId, row.id);
}

/** Enabled personal owned by user, plus shared the user may read. */
export function visibleUpstreamIdsForUser(userId: string): Set<string> {
  const db = getDb();
  const elevated = isElevatedRole(roleForUser(userId));
  if (elevated) {
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

  const personal = db
    .select({ id: upstreams.id })
    .from(upstreams)
    .where(
      and(
        eq(upstreams.enabled, true),
        eq(upstreams.visibility, "personal"),
        eq(upstreams.ownerUserId, userId),
      ),
    )
    .all();

  const granted = db
    .select({ id: upstreams.id })
    .from(upstreams)
    .innerJoin(
      upstreamGrants,
      and(
        eq(upstreamGrants.upstreamId, upstreams.id),
        eq(upstreamGrants.userId, userId),
      ),
    )
    .where(
      and(eq(upstreams.enabled, true), eq(upstreams.visibility, "shared")),
    )
    .all();

  return new Set([...personal, ...granted].map((r) => r.id));
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
