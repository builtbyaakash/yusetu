import { asc, count, eq } from "drizzle-orm";
import type { Context } from "hono";
import { setCookie } from "hono/cookie";
import {
  CreateInviteSchema,
  JoinBodySchema,
  PatchMemberRoleSchema,
} from "@yusetu/shared";
import { parseRole } from "../auth/context.js";
import {
  hashPassword,
  hashToken,
  generateSessionToken,
  SESSION_COOKIE,
  SESSION_TTL_MS,
} from "../auth/crypto.js";
import { createSession } from "../auth/sessions.js";
import { getDb } from "../db/index.js";
import { invites, users } from "../db/schema.js";
import { getLogger } from "../logger.js";

const INVITE_TTL_MS = 1000 * 60 * 60 * 24 * 7;

function setSessionCookie(c: Context, token: string): void {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
    secure: c.req.url.startsWith("https://"),
  });
}

function ownerCount(): number {
  const db = getDb();
  return (
    db
      .select({ value: count() })
      .from(users)
      .where(eq(users.role, "owner"))
      .get()?.value ?? 0
  );
}

function serializeInvite(row: typeof invites.$inferSelect) {
  return {
    id: row.id,
    role: row.role,
    createdByUserId: row.createdByUserId,
    expiresAt: row.expiresAt.toISOString(),
    usedAt: row.usedAt?.toISOString() ?? null,
    usedByUserId: row.usedByUserId,
    createdAt: row.createdAt.toISOString(),
  };
}

function serializeMember(row: typeof users.$inferSelect) {
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    createdAt: row.createdAt.toISOString(),
    lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
  };
}

export async function createInvite(c: Context) {
  const parsed = CreateInviteSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json(
      { error: "Invalid body", details: parsed.error.flatten() },
      400,
    );
  }

  const creator = c.get("user") as { id: string };
  const rawToken = generateSessionToken();
  const id = crypto.randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + INVITE_TTL_MS);

  getDb()
    .insert(invites)
    .values({
      id,
      tokenHash: hashToken(rawToken),
      role: parsed.data.role,
      createdByUserId: creator.id,
      expiresAt,
      createdAt: now,
    })
    .run();

  getLogger("control").info({ inviteId: id, role: parsed.data.role }, "invite created");

  return c.json(
    {
      invite: serializeInvite(
        getDb().select().from(invites).where(eq(invites.id, id)).get()!,
      ),
      token: rawToken,
      joinPath: `/join?token=${encodeURIComponent(rawToken)}`,
    },
    201,
  );
}

export async function listInvites(c: Context) {
  const db = getDb();
  const rows = db
    .select()
    .from(invites)
    .orderBy(asc(invites.createdAt))
    .all();
  return c.json(rows.map(serializeInvite));
}

export async function revokeInvite(c: Context) {
  const id = c.req.param("id");
  if (!id) return c.json({ error: "Missing id" }, 400);

  const db = getDb();
  const row = db.select().from(invites).where(eq(invites.id, id)).get();
  if (!row) return c.json({ error: "Not found" }, 404);
  if (row.usedAt) {
    return c.json({ error: "Invite already used" }, 409);
  }

  db.delete(invites).where(eq(invites.id, id)).run();
  return c.body(null, 204);
}

export async function listMembers(c: Context) {
  const db = getDb();
  const rows = db.select().from(users).orderBy(asc(users.createdAt)).all();
  return c.json(rows.map(serializeMember));
}

export async function patchMemberRole(c: Context) {
  const userId = c.req.param("userId");
  if (!userId) return c.json({ error: "Missing userId" }, 400);

  const parsed = PatchMemberRoleSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json(
      { error: "Invalid body", details: parsed.error.flatten() },
      400,
    );
  }

  const db = getDb();
  const row = db.select().from(users).where(eq(users.id, userId)).get();
  if (!row) return c.json({ error: "Not found" }, 404);

  const nextRole = parsed.data.role;
  if (row.role === "owner" && nextRole !== "owner" && ownerCount() <= 1) {
    return c.json({ error: "Cannot demote the last owner" }, 409);
  }

  db.update(users).set({ role: nextRole }).where(eq(users.id, userId)).run();
  const updated = db.select().from(users).where(eq(users.id, userId)).get()!;
  return c.json(serializeMember(updated));
}

export async function removeMember(c: Context) {
  const userId = c.req.param("userId");
  if (!userId) return c.json({ error: "Missing userId" }, 400);

  const db = getDb();
  const row = db.select().from(users).where(eq(users.id, userId)).get();
  if (!row) return c.json({ error: "Not found" }, 404);

  if (row.role === "owner" && ownerCount() <= 1) {
    return c.json({ error: "Cannot remove the last owner" }, 409);
  }

  db.delete(users).where(eq(users.id, userId)).run();
  return c.body(null, 204);
}

export async function handleJoin(c: Context) {
  const log = getLogger("control");
  const body = JoinBodySchema.safeParse(await c.req.json());
  if (!body.success) {
    return c.json({ error: "Invalid body", details: body.error.flatten() }, 400);
  }

  const db = getDb();
  const existing = db
    .select()
    .from(users)
    .where(eq(users.username, body.data.username))
    .get();
  if (existing) {
    return c.json({ error: "Username already taken" }, 409);
  }

  const tokenHash = hashToken(body.data.token);
  const invite = db
    .select()
    .from(invites)
    .where(eq(invites.tokenHash, tokenHash))
    .get();

  if (!invite) {
    return c.json({ error: "Invalid invite" }, 400);
  }
  if (invite.usedAt) {
    return c.json({ error: "Invite already used" }, 409);
  }
  if (invite.expiresAt.getTime() < Date.now()) {
    return c.json({ error: "Invite expired" }, 410);
  }

  const now = new Date();
  const userId = crypto.randomUUID();
  const passwordHash = await hashPassword(body.data.password);

  db.insert(users)
    .values({
      id: userId,
      username: body.data.username,
      passwordHash,
      role: invite.role,
      createdAt: now,
      lastLoginAt: now,
    })
    .run();

  db.update(invites)
    .set({ usedAt: now, usedByUserId: userId })
    .where(eq(invites.id, invite.id))
    .run();

  const sessionToken = await createSession(userId);
  setSessionCookie(c, sessionToken);
  log.info({ userId, username: body.data.username, role: invite.role }, "invite join");

  const user = db.select().from(users).where(eq(users.id, userId)).get()!;
  return c.json(
    {
      id: user.id,
      username: user.username,
      role: parseRole(user.role),
    },
    201,
  );
}
