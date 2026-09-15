import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { hashToken } from "../auth/crypto.js";

export function verifyS256(codeVerifier: string, codeChallenge: string): boolean {
  const computed = createHash("sha256")
    .update(codeVerifier, "utf8")
    .digest("base64url");
  if (computed.length !== codeChallenge.length) return false;
  try {
    return timingSafeEqual(
      Buffer.from(computed, "utf8"),
      Buffer.from(codeChallenge, "utf8"),
    );
  } catch {
    return false;
  }
}

export function generateAuthCode(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString("base64url");
  return { raw, hash: hashToken(raw) };
}

export function generateAccessToken(): { raw: string; hash: string } {
  const raw = `ysat_${randomBytes(32).toString("base64url")}`;
  return { raw, hash: hashToken(raw) };
}

export function generateRefreshToken(): { raw: string; hash: string } {
  const raw = `ysrt_${randomBytes(32).toString("base64url")}`;
  return { raw, hash: hashToken(raw) };
}

export function generateClientId(): string {
  return `ysc_${randomBytes(16).toString("base64url")}`;
}

export function generateClientSecret(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString("base64url");
  return { raw, hash: hashToken(raw) };
}
