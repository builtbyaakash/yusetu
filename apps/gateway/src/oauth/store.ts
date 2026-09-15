import { and, eq, gt, isNull } from "drizzle-orm";
import { hashToken } from "../auth/crypto.js";
import { getDb } from "../db/index.js";
import {
  oauthAuthCodes,
  oauthClients,
  oauthTokens,
  type OauthAuthCode,
  type OauthClient,
  type OauthToken,
} from "../db/schema.js";
import {
  generateAccessToken,
  generateAuthCode,
  generateClientId,
  generateClientSecret,
  generateRefreshToken,
} from "./pkce.js";

export const AUTH_CODE_TTL_MS = 1000 * 60 * 10; // 10 minutes
export const ACCESS_TOKEN_TTL_MS = 1000 * 60 * 60; // 1 hour
export const REFRESH_TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days
export const DEFAULT_SCOPE = "mcp:tools";

export function parseJsonArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === "string");
  } catch {
    return [];
  }
}

export function findClientByClientId(clientId: string): OauthClient | null {
  const db = getDb();
  return (
    db
      .select()
      .from(oauthClients)
      .where(eq(oauthClients.clientId, clientId))
      .get() ?? null
  );
}

export function createOauthClient(input: {
  clientName: string;
  redirectUris: string[];
  grantTypes: string[];
  tokenEndpointAuthMethod: string;
  issueSecret: boolean;
}): { client: OauthClient; clientSecret: string | null } {
  const db = getDb();
  const now = new Date();
  const clientId = generateClientId();
  const secret = input.issueSecret ? generateClientSecret() : null;
  const id = crypto.randomUUID();

  db.insert(oauthClients)
    .values({
      id,
      clientId,
      clientSecretHash: secret?.hash ?? null,
      clientName: input.clientName,
      redirectUrisJson: JSON.stringify(input.redirectUris),
      grantTypesJson: JSON.stringify(input.grantTypes),
      tokenEndpointAuthMethod: input.tokenEndpointAuthMethod,
      createdAt: now,
    })
    .run();

  const client = db
    .select()
    .from(oauthClients)
    .where(eq(oauthClients.id, id))
    .get()!;

  return { client, clientSecret: secret?.raw ?? null };
}

export function verifyClientSecret(
  client: OauthClient,
  clientSecret: string | undefined,
): boolean {
  if (client.tokenEndpointAuthMethod === "none") {
    return true;
  }
  if (!client.clientSecretHash || !clientSecret) return false;
  return hashToken(clientSecret) === client.clientSecretHash;
}

export function createAuthCode(input: {
  clientId: string;
  userId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  resource: string | null;
  scopes: string;
}): { raw: string; row: OauthAuthCode } {
  const db = getDb();
  const { raw, hash } = generateAuthCode();
  const now = new Date();
  const id = crypto.randomUUID();

  db.insert(oauthAuthCodes)
    .values({
      id,
      codeHash: hash,
      clientId: input.clientId,
      userId: input.userId,
      redirectUri: input.redirectUri,
      codeChallenge: input.codeChallenge,
      codeChallengeMethod: input.codeChallengeMethod,
      resource: input.resource,
      scopes: input.scopes,
      expiresAt: new Date(now.getTime() + AUTH_CODE_TTL_MS),
      usedAt: null,
    })
    .run();

  const row = db
    .select()
    .from(oauthAuthCodes)
    .where(eq(oauthAuthCodes.id, id))
    .get()!;

  return { raw, row };
}

export function findValidAuthCode(code: string): OauthAuthCode | null {
  const db = getDb();
  const now = new Date();
  return (
    db
      .select()
      .from(oauthAuthCodes)
      .where(
        and(
          eq(oauthAuthCodes.codeHash, hashToken(code)),
          gt(oauthAuthCodes.expiresAt, now),
          isNull(oauthAuthCodes.usedAt),
        ),
      )
      .get() ?? null
  );
}

export function markAuthCodeUsed(id: string): void {
  const db = getDb();
  db.update(oauthAuthCodes)
    .set({ usedAt: new Date() })
    .where(eq(oauthAuthCodes.id, id))
    .run();
}

export function issueTokenPair(input: {
  clientId: string;
  userId: string;
  resource: string | null;
  scopes: string;
}): {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  scope: string;
} {
  const db = getDb();
  const now = new Date();
  const refresh = generateRefreshToken();
  const access = generateAccessToken();
  const refreshId = crypto.randomUUID();
  const accessId = crypto.randomUUID();

  db.insert(oauthTokens)
    .values({
      id: refreshId,
      tokenType: "refresh",
      tokenHash: refresh.hash,
      clientId: input.clientId,
      userId: input.userId,
      resource: input.resource,
      scopes: input.scopes,
      expiresAt: new Date(now.getTime() + REFRESH_TOKEN_TTL_MS),
      refreshTokenId: null,
      createdAt: now,
      revokedAt: null,
    })
    .run();

  db.insert(oauthTokens)
    .values({
      id: accessId,
      tokenType: "access",
      tokenHash: access.hash,
      clientId: input.clientId,
      userId: input.userId,
      resource: input.resource,
      scopes: input.scopes,
      expiresAt: new Date(now.getTime() + ACCESS_TOKEN_TTL_MS),
      refreshTokenId: refreshId,
      createdAt: now,
      revokedAt: null,
    })
    .run();

  return {
    accessToken: access.raw,
    refreshToken: refresh.raw,
    expiresIn: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
    scope: input.scopes,
  };
}

export function findValidAccessToken(raw: string): OauthToken | null {
  const db = getDb();
  const now = new Date();
  return (
    db
      .select()
      .from(oauthTokens)
      .where(
        and(
          eq(oauthTokens.tokenHash, hashToken(raw)),
          eq(oauthTokens.tokenType, "access"),
          gt(oauthTokens.expiresAt, now),
          isNull(oauthTokens.revokedAt),
        ),
      )
      .get() ?? null
  );
}

export function findValidRefreshToken(raw: string): OauthToken | null {
  const db = getDb();
  const now = new Date();
  return (
    db
      .select()
      .from(oauthTokens)
      .where(
        and(
          eq(oauthTokens.tokenHash, hashToken(raw)),
          eq(oauthTokens.tokenType, "refresh"),
          gt(oauthTokens.expiresAt, now),
          isNull(oauthTokens.revokedAt),
        ),
      )
      .get() ?? null
  );
}

export function revokeToken(id: string): void {
  const db = getDb();
  db.update(oauthTokens)
    .set({ revokedAt: new Date() })
    .where(eq(oauthTokens.id, id))
    .run();
}

export function revokeTokensForRefresh(refreshTokenId: string): void {
  const db = getDb();
  const now = new Date();
  db.update(oauthTokens)
    .set({ revokedAt: now })
    .where(eq(oauthTokens.id, refreshTokenId))
    .run();
  db.update(oauthTokens)
    .set({ revokedAt: now })
    .where(eq(oauthTokens.refreshTokenId, refreshTokenId))
    .run();
}
