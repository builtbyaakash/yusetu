import { createHash, randomBytes } from "node:crypto";
import * as argon2 from "argon2";

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, { type: argon2.argon2id });
}

export async function verifyPassword(
  hash: string,
  password: string,
): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

export function generateSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function generateApiKey(): { raw: string; prefix: string; hash: string } {
  const raw = `ysk_${randomBytes(24).toString("base64url")}`;
  const prefix = raw.slice(0, 12);
  return { raw, prefix, hash: hashToken(raw) };
}

export const SESSION_COOKIE = "yusetu_session";
export const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14; // 14 days
