import type { Context } from "hono";
import { Hono } from "hono";
import { verifyS256 } from "./pkce.js";
import {
  findClientByClientId,
  findValidAuthCode,
  findValidRefreshToken,
  issueTokenPair,
  markAuthCodeUsed,
  revokeTokensForRefresh,
  verifyClientSecret,
} from "./store.js";

async function readTokenBody(
  c: Context,
): Promise<Record<string, string>> {
  const contentType = c.req.header("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const json = (await c.req.json()) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(json)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  }
  const form = await c.req.parseBody();
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(form)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

function oauthError(
  c: Context,
  status: 400 | 401,
  error: string,
  description: string,
) {
  if (status === 401) {
    c.header("WWW-Authenticate", 'Bearer error="invalid_client"');
  }
  return c.json({ error, error_description: description }, status);
}

export async function handleToken(c: Context) {
  const body = await readTokenBody(c);
  const grantType = (body.grant_type ?? "").trim();
  const clientId = (body.client_id ?? "").trim();
  const clientSecret = body.client_secret;

  if (!clientId) {
    return oauthError(c, 400, "invalid_request", "client_id is required");
  }

  const client = findClientByClientId(clientId);
  if (!client) {
    return oauthError(c, 401, "invalid_client", "Unknown client_id");
  }

  if (!verifyClientSecret(client, clientSecret)) {
    return oauthError(c, 401, "invalid_client", "Invalid client credentials");
  }

  if (grantType === "authorization_code") {
    const code = (body.code ?? "").trim();
    const redirectUri = (body.redirect_uri ?? "").trim();
    const codeVerifier = (body.code_verifier ?? "").trim();

    if (!code || !redirectUri || !codeVerifier) {
      return oauthError(
        c,
        400,
        "invalid_request",
        "code, redirect_uri, and code_verifier are required",
      );
    }

    const authCode = findValidAuthCode(code);
    if (!authCode) {
      return oauthError(
        c,
        400,
        "invalid_grant",
        "Authorization code is invalid or expired",
      );
    }

    if (authCode.clientId !== clientId) {
      return oauthError(
        c,
        400,
        "invalid_grant",
        "Authorization code was not issued to this client",
      );
    }

    if (authCode.redirectUri !== redirectUri) {
      return oauthError(
        c,
        400,
        "invalid_grant",
        "redirect_uri does not match",
      );
    }

    if (authCode.codeChallengeMethod !== "S256") {
      return oauthError(
        c,
        400,
        "invalid_grant",
        "Unsupported code_challenge_method",
      );
    }

    if (!verifyS256(codeVerifier, authCode.codeChallenge)) {
      return oauthError(c, 400, "invalid_grant", "PKCE verification failed");
    }

    markAuthCodeUsed(authCode.id);

    const tokens = issueTokenPair({
      clientId,
      userId: authCode.userId,
      resource: authCode.resource,
      scopes: authCode.scopes,
    });

    return c.json({
      access_token: tokens.accessToken,
      token_type: "Bearer",
      expires_in: tokens.expiresIn,
      refresh_token: tokens.refreshToken,
      scope: tokens.scope,
    });
  }

  if (grantType === "refresh_token") {
    const refreshToken = (body.refresh_token ?? "").trim();
    if (!refreshToken) {
      return oauthError(
        c,
        400,
        "invalid_request",
        "refresh_token is required",
      );
    }

    const existing = findValidRefreshToken(refreshToken);
    if (!existing || existing.clientId !== clientId) {
      return oauthError(
        c,
        400,
        "invalid_grant",
        "Refresh token is invalid or expired",
      );
    }

    // Rotate refresh token
    revokeTokensForRefresh(existing.id);

    const tokens = issueTokenPair({
      clientId,
      userId: existing.userId,
      resource: existing.resource,
      scopes: existing.scopes,
    });

    return c.json({
      access_token: tokens.accessToken,
      token_type: "Bearer",
      expires_in: tokens.expiresIn,
      refresh_token: tokens.refreshToken,
      scope: tokens.scope,
    });
  }

  return oauthError(
    c,
    400,
    "unsupported_grant_type",
    "Only authorization_code and refresh_token are supported",
  );
}

export function createOauthTokenRoutes(): Hono {
  const app = new Hono();
  app.post("/oauth/token", (c) => handleToken(c));
  return app;
}
