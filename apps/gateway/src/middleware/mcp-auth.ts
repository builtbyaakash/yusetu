import { and, eq } from "drizzle-orm";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import type { GatewayConfig } from "../config.js";
import { getDb } from "../db/index.js";
import { apiKeys, settings } from "../db/schema.js";
import { hashToken } from "../auth/crypto.js";
import { getPublicOrigin } from "../oauth/metadata.js";
import { findValidAccessToken } from "../oauth/store.js";

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

function validateApiKey(raw: string): boolean {
  const db = getDb();
  const key = db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.keyHash, hashToken(raw)), eq(apiKeys.enabled, true)))
    .get();

  if (!key) return false;

  db.update(apiKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(apiKeys.id, key.id))
    .run();

  return true;
}

function validateOauthAccessToken(
  raw: string,
  enableMcpOauth: boolean,
): boolean {
  if (!enableMcpOauth) return false;
  if (!raw.startsWith("ysat_")) return false;
  return findValidAccessToken(raw) !== null;
}

export function createMcpAuthMiddleware(config: GatewayConfig) {
  return createMiddleware(async (c, next) => {
    if (!mcpAuthRequired(config)) {
      await next();
      return;
    }

    const xApiKey = c.req.header("x-api-key")?.trim();
    const authHeader = c.req.header("authorization");
    const bearer =
      authHeader?.toLowerCase().startsWith("bearer ")
        ? authHeader.slice(7).trim()
        : null;

    if (xApiKey) {
      if (validateApiKey(xApiKey)) {
        await next();
        return;
      }
      return unauthorized(c, config.enableMcpOauth);
    }

    if (!bearer) {
      return unauthorized(c, config.enableMcpOauth);
    }

    // OAuth access tokens use ysat_ prefix
    if (validateOauthAccessToken(bearer, config.enableMcpOauth)) {
      await next();
      return;
    }

    // API keys via Bearer (ysk_…) or legacy bearer tokens
    if (validateApiKey(bearer)) {
      await next();
      return;
    }

    return unauthorized(c, config.enableMcpOauth);
  });
}
