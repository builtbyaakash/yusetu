import { and, eq, gt, lt } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { sessions, users, type User } from "../db/schema.js";
import {
  generateSessionToken,
  hashToken,
  SESSION_TTL_MS,
} from "./crypto.js";

export async function createSession(userId: string): Promise<string> {
  const db = getDb();
  const token = generateSessionToken();
  const now = new Date();
  db.insert(sessions)
    .values({
      id: crypto.randomUUID(),
      userId,
      tokenHash: hashToken(token),
      expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
      createdAt: now,
    })
    .run();
  return token;
}

export function deleteSessionByToken(token: string): void {
  const db = getDb();
  db.delete(sessions).where(eq(sessions.tokenHash, hashToken(token))).run();
}

export function purgeExpiredSessions(): void {
  const db = getDb();
  db.delete(sessions).where(lt(sessions.expiresAt, new Date())).run();
}

export function findUserBySessionToken(token: string): User | null {
  const db = getDb();
  const now = new Date();
  const row = db
    .select({ user: users })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(
      and(eq(sessions.tokenHash, hashToken(token)), gt(sessions.expiresAt, now)),
    )
    .get();
  return row?.user ?? null;
}
