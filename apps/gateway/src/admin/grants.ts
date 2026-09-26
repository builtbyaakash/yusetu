import { and, asc, eq } from "drizzle-orm";
import type { Context } from "hono";
import { CreateUpstreamGrantSchema } from "@yusetu/shared";
import { getDb } from "../db/index.js";
import { upstreamGrants, upstreams, users } from "../db/schema.js";
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
