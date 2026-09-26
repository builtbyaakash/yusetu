import { and, eq } from "drizzle-orm";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import type { AuthContext } from "../auth/context.js";
import { parseRole } from "../auth/context.js";
import type { GatewayConfig } from "../config.js";
import { getDb } from "../db/index.js";
import { apiKeys, settings, users } from "../db/schema.js";
import { hashToken } from "../auth/crypto.js";
import { getPublicOrigin } from "../oauth/metadata.js";
import { findValidAccessToken } from "../oauth/store.js";

export type McpAuthVariables = {
  auth: AuthContext;
};

function mcpAuthRequired(config: GatewayConfig): boolean {
  if (config.requireMcpAuth) return true;
  const db = getDb();
  const row = db
    .select()
    .from(settings)
    .where(eq(settings.key, "requireMcpAuth"))
    .get();
  return row?.value === "true" || row?.value === "1";
}

function unauthorized(c: Context, enableMcpOauth: boolean) {
  if (enableMcpOauth) {
    const origin = getPublicOrigin(c);
    const resourceMetadata = `${origin}/.well-known/oauth-protected-resource`;
    c.header(
      "WWW-Authenticate",
      `Bearer FAKESECRET_g3h4i5j6k7l8m9n0o1p2="${resourceMetadata}", error="invalid_token"`,
    );
  }
  return c.json({ error: "Unauthorized" }, 401);
}

function authContextForUserId(userId: string): AuthContext | null {
  const db = getDb();
  const user = db.select().from(users).where(eq(users.id, userId)).get();
  if (!user) return null;
  return {
    userId: user.id,
    username: user.username,
    role: parseRole(user.role),
  };
}

function resolveApiKey(raw: string): AuthContext | null {
  const db = getDb();
  const key = db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.keyHash, hashToken(raw)), eq(apiKeys.enabled, true)))
    .get();

  if (!key?.userId) return null;

  db.update(apiKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(apiKeys.id, key.id))
    .run();

  return authContextForUserId(key.userId);
}

function resolveOauthAccessToken(
  raw: string,
  enableMcpOauth: boolean,
): AuthContext | null {
  if (!enableMcpOauth) return null;
  if (!raw.startsWith("ysat_")) return null;
  const token = findValidAccessToken(raw);
  if (!token) return null;
  return authContextForUserId(token.userId);
}

export function createMcpAuthMiddleware(config: GatewayConfig) {
  return createMiddleware<{ Variables: Partial<McpAuthVariables> }>(
    async (c, next) => {
      const required = mcpAuthRequired(config);

      const xApiKey = c.req.header("x-api-key")?.trim();
      const authHeader = c.req.header("authorization");
      const bearer =
        authHeader?.toLowerCase().startsWith("bearer ")
          ? authHeader.slice(7).trim()
          : null;

      let auth: AuthContext | null = null;

      if (xApiKey) {
        auth = resolveApiKey(xApiKey);
      } else if (bearer) {
        auth = resolveOauthAccessToken(bearer, config.enableMcpOauth);
        if (!auth) {
          auth = resolveApiKey(bearer);
        }
      }

      if (auth) {
        c.set("auth", auth);
      }

      if (!required) {
        await next();
        return;
      }

      if (!auth) {
        return unauthorized(c, config.enableMcpOauth);
      }

      await next();
    },
  );
}
