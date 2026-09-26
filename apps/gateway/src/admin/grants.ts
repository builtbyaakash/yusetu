import { and, asc, count, eq } from "drizzle-orm";
import type { Context } from "hono";
import { CreateUpstreamGrantSchema } from "@yusetu/shared";
import { getDb, getSqlite } from "../db/index.js";
import { tools, upstreamGrants, upstreams, users } from "../db/schema.js";
import { getLogger } from "../logger.js";

function serializeGrant(row: {
  id: string;
  upstreamId: string;
  userId: string;
  username: string;
  createdAt: Date;
}) {
  return {
    id: row.id,
    upstreamId: row.upstreamId,
    userId: row.userId,
    username: row.username,
    createdAt: row.createdAt.toISOString(),
  };
}

function loadSharedUpstream(upstreamId: string) {
  const row = getDb()
    .select()
    .from(upstreams)
    .where(eq(upstreams.id, upstreamId))
    .get();
  if (!row) return { error: "Not found" as const, status: 404 as const };
  if (row.visibility !== "shared") {
    return {
      error: "Grants only apply to shared MCPs" as const,
      status: 400 as const,
    };
  }
  return { row };
}

function serializeUpstreamBrief(row: {
  id: string;
  slug: string;
  name: string;
  visibility: "shared" | "personal";
  ownerUserId: string | null;
  enabled: boolean;
  createdAt: Date;
  createdByUserId: string | null;
}) {
  const toolCount =
    getDb()
      .select({ value: count() })
      .from(tools)
      .where(eq(tools.upstreamId, row.id))
      .get()?.value ?? 0;
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    visibility: row.visibility,
    ownerUserId: row.ownerUserId,
    enabled: row.enabled,
    createdAt: row.createdAt.toISOString(),
    createdByUserId: row.createdByUserId,
    toolCount,
  };
}

/**
 * ShareLifecycle: personal → shared.
 * Clears owner_user_id. Elevated only (route middleware).
 */
export async function promoteToShared(c: Context) {
  const upstreamId = c.req.param("id");
  if (!upstreamId) return c.json({ error: "Missing id" }, 400);

  const db = getDb();
  const row = db
    .select()
    .from(upstreams)
    .where(eq(upstreams.id, upstreamId))
    .get();
  if (!row) return c.json({ error: "Not found" }, 404);
  if (row.visibility === "shared") {
    return c.json(serializeUpstreamBrief(row));
  }
  if (row.visibility !== "personal") {
    return c.json({ error: "Only personal MCPs can be shared" }, 400);
  }

  db.update(upstreams)
    .set({ visibility: "shared", ownerUserId: null })
    .where(eq(upstreams.id, upstreamId))
    .run();

  const updated = db
    .select()
    .from(upstreams)
    .where(eq(upstreams.id, upstreamId))
    .get()!;

  getLogger("control").info(
    { upstreamId },
    "upstream promoted to shared",
  );
  return c.json(serializeUpstreamBrief(updated));
}

/**
 * ShareLifecycle: shared → personal.
 * Sets owner to acting elevated user, deletes all grants.
 */
export async function unshareToPersonal(c: Context) {
  const upstreamId = c.req.param("id");
  if (!upstreamId) return c.json({ error: "Missing id" }, 400);

  const user = c.get("user") as { id: string };
  const db = getDb();
  const row = db
    .select()
    .from(upstreams)
    .where(eq(upstreams.id, upstreamId))
    .get();
  if (!row) return c.json({ error: "Not found" }, 404);
  if (row.visibility === "personal") {
    return c.json(serializeUpstreamBrief(row));
  }
  if (row.visibility !== "shared") {
    return c.json({ error: "Only shared MCPs can be unshared" }, 400);
  }

  const sqlite = getSqlite();
  const tx = sqlite.transaction(() => {
    db.delete(upstreamGrants)
      .where(eq(upstreamGrants.upstreamId, upstreamId))
      .run();
    db.update(upstreams)
      .set({ visibility: "personal", ownerUserId: user.id })
      .where(eq(upstreams.id, upstreamId))
      .run();
  });
  tx();

  const updated = db
    .select()
    .from(upstreams)
    .where(eq(upstreams.id, upstreamId))
    .get()!;

  getLogger("control").info(
    { upstreamId, ownerUserId: user.id },
    "upstream unshared to personal",
  );
  return c.json(serializeUpstreamBrief(updated));
}

export async function listUpstreamGrants(c: Context) {
  const upstreamId = c.req.param("id");
  if (!upstreamId) return c.json({ error: "Missing id" }, 400);

  const loaded = loadSharedUpstream(upstreamId);
  if ("error" in loaded) return c.json({ error: loaded.error }, loaded.status);

  const rows = getDb()
    .select({
      id: upstreamGrants.id,
      upstreamId: upstreamGrants.upstreamId,
      userId: upstreamGrants.userId,
      username: users.username,
      createdAt: upstreamGrants.createdAt,
    })
    .from(upstreamGrants)
    .innerJoin(users, eq(users.id, upstreamGrants.userId))
    .where(eq(upstreamGrants.upstreamId, upstreamId))
    .orderBy(asc(users.username))
    .all();

  return c.json(rows.map(serializeGrant));
}

export async function createUpstreamGrant(c: Context) {
  const upstreamId = c.req.param("id");
  if (!upstreamId) return c.json({ error: "Missing id" }, 400);

  const parsed = CreateUpstreamGrantSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json(
      { error: "Invalid body", details: parsed.error.flatten() },
      400,
    );
  }

  const loaded = loadSharedUpstream(upstreamId);
  if ("error" in loaded) return c.json({ error: loaded.error }, loaded.status);

  const db = getDb();
  const user = db
    .select()
    .from(users)
    .where(eq(users.id, parsed.data.userId))
    .get();
  if (!user) return c.json({ error: "User not found" }, 404);

  const existing = db
    .select({
      id: upstreamGrants.id,
      upstreamId: upstreamGrants.upstreamId,
      userId: upstreamGrants.userId,
      username: users.username,
      createdAt: upstreamGrants.createdAt,
    })
    .from(upstreamGrants)
    .innerJoin(users, eq(users.id, upstreamGrants.userId))
    .where(
      and(
        eq(upstreamGrants.upstreamId, upstreamId),
        eq(upstreamGrants.userId, parsed.data.userId),
      ),
    )
    .get();

  if (existing) {
    return c.json(serializeGrant(existing), 200);
  }

  const id = crypto.randomUUID();
  const now = new Date();
  db.insert(upstreamGrants)
    .values({
      id,
      upstreamId,
      userId: parsed.data.userId,
      createdAt: now,
    })
    .run();

  getLogger("control").info(
    { grantId: id, upstreamId, userId: parsed.data.userId },
    "upstream grant created",
  );

  return c.json(
    serializeGrant({
      id,
      upstreamId,
      userId: parsed.data.userId,
      username: user.username,
      createdAt: now,
    }),
    201,
  );
}

export async function revokeUpstreamGrant(c: Context) {
  const upstreamId = c.req.param("id");
  const userId = c.req.param("userId");
  if (!upstreamId || !userId) {
    return c.json({ error: "Missing id or userId" }, 400);
  }

  const loaded = loadSharedUpstream(upstreamId);
  if ("error" in loaded) return c.json({ error: loaded.error }, loaded.status);

  const db = getDb();
  const row = db
    .select()
    .from(upstreamGrants)
    .where(
      and(
        eq(upstreamGrants.upstreamId, upstreamId),
        eq(upstreamGrants.userId, userId),
      ),
    )
    .get();
  if (!row) return c.json({ error: "Not found" }, 404);

  db.delete(upstreamGrants).where(eq(upstreamGrants.id, row.id)).run();
  getLogger("control").info(
    { grantId: row.id, upstreamId, userId },
    "upstream grant revoked",
  );
  return c.body(null, 204);
}
