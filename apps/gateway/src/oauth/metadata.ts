import type { Context } from "hono";
import { Hono } from "hono";

export function getPublicOrigin(c: Context): string {
  const proto = c.req.header("x-forwarded-proto")?.split(",")[0]?.trim();
  const host = c.req.header("x-forwarded-host")?.split(",")[0]?.trim();
  if (proto && host) {
    return `${proto}://${host}`;
  }
  return new URL(c.req.url).origin;
}

export function protectedResourceMetadata(origin: string) {
  return {
    resource: `${origin}/mcp`,
    authorization_servers: [origin],
    scopes_supported: ["mcp:tools"],
    bearer_methods_supported: ["header"],
  };
}

export function authorizationServerMetadata(origin: string) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
    scopes_supported: ["mcp:tools"],
  };
}

export function createOauthMetadataRoutes(): Hono {
  const app = new Hono();

  const sendPrm = (c: Context) => {
    const origin = getPublicOrigin(c);
    return c.json(protectedResourceMetadata(origin));
  };

  app.get("/.well-known/oauth-protected-resource", sendPrm);
  app.get("/.well-known/oauth-protected-resource/mcp", sendPrm);

  app.get("/.well-known/oauth-authorization-server", (c) => {
    const origin = getPublicOrigin(c);
    return c.json(authorizationServerMetadata(origin));
  });

  return app;
}
