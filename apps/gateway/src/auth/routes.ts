import { count, eq } from "drizzle-orm";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import {
  LoginBodySchema,
  SetupBodySchema,
  type AuthMeResponse,
} from "@yusetu/shared";
import { getDb } from "../db/index.js";
import { users } from "../db/schema.js";
import { getLogger } from "../logger.js";
import {
  hashPassword,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  verifyPassword,
} from "./crypto.js";
import {
  createSession,
  deleteSessionByToken,
  findUserBySessionToken,
  purgeExpiredSessions,
} from "./sessions.js";

function setSessionCookie(c: Context, token: string): void {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
    secure: c.req.url.startsWith("https://"),
  });
}

function clearSessionCookie(c: Context): void {
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}

export function userCount(): number {
  const db = getDb();
  const row = db.select({ value: count() }).from(users).get();
  return row?.value ?? 0;
}

export async function handleSetup(c: Context) {
  const log = getLogger("control");
  if (userCount() > 0) {
    return c.json({ error: "Setup already completed" }, 409);
  }

  const body = SetupBodySchema.safeParse(await c.req.json());
  if (!body.success) {
    return c.json({ error: "Invalid body", details: body.error.flatten() }, 400);
  }

  const db = getDb();
  const now = new Date();
  const id = crypto.randomUUID();
  const passwordHash = await hashPassword(body.data.password);

  db.insert(users)
    .values({
      id,
      username: body.data.username,
      passwordHash,
      createdAt: now,
      lastLoginAt: now,
    })
    .run();

  const token = await createSession(id);
  setSessionCookie(c, token);
  log.info({ userId: id, username: body.data.username }, "admin setup complete");

  const me: AuthMeResponse = { id, username: body.data.username };
  return c.json(me, 201);
}

export async function handleLogin(c: Context) {
  purgeExpiredSessions();
  if (userCount() === 0) {
    clearSessionCookie(c);
    return c.json({ error: "Setup required", setupRequired: true }, 403);
  }

  const body = LoginBodySchema.safeParse(await c.req.json());
  if (!body.success) {
    return c.json({ error: "Invalid body", details: body.error.flatten() }, 400);
  }

  const db = getDb();
  const user = db
    .select()
    .from(users)
    .where(eq(users.username, body.data.username))
    .get();

  if (!user || !(await verifyPassword(user.passwordHash, body.data.password))) {
    return c.json({ error: "Invalid username or password" }, 401);
  }

  db.update(users)
    .set({ lastLoginAt: new Date() })
    .where(eq(users.id, user.id))
    .run();

  const token = await createSession(user.id);
  setSessionCookie(c, token);

  const me: AuthMeResponse = { id: user.id, username: user.username };
  return c.json(me);
}

export async function handleLogout(c: Context) {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) {
    deleteSessionByToken(token);
  }
  clearSessionCookie(c);
  return c.json({ ok: true });
}

export async function handleMe(c: Context) {
  // Empty DB = first-run signup; never honor a stale session cookie.
  if (userCount() === 0) {
    const token = getCookie(c, SESSION_COOKIE);
    if (token) {
      deleteSessionByToken(token);
    }
    clearSessionCookie(c);
    return c.json({ error: "Setup required", setupRequired: true }, 401);
  }

  const token = getCookie(c, SESSION_COOKIE);
  if (!token) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const user = findUserBySessionToken(token);
  if (!user) {
    clearSessionCookie(c);
    return c.json({ error: "Unauthorized" }, 401);
  }
  const me: AuthMeResponse = { id: user.id, username: user.username };
  return c.json(me);
}

export function getSessionUser(c: Context) {
  if (userCount() === 0) return null;
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return null;
  return findUserBySessionToken(token);
}
