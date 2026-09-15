import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import { createOauthClient, DEFAULT_SCOPE } from "./store.js";

const RegisterBodySchema = z.object({
  client_name: z.string().min(1).max(200).optional(),
  // Absolute URIs; allow custom schemes used by IDE OAuth callbacks
  redirect_uris: z
    .array(z.string().min(1).refine((u) => /^[a-z][a-z0-9+.-]*:/i.test(u)))
    .min(1),
  grant_types: z
    .array(z.string())
    .optional()
    .default(["authorization_code", "refresh_token"]),
  response_types: z.array(z.string()).optional().default(["code"]),
  token_endpoint_auth_method: z
    .enum(["none", "client_secret_post"])
    .optional()
    .default("none"),
  scope: z.string().optional(),
});

export async function handleRegister(c: Context) {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json(
      {
        error: "invalid_client_metadata",
        error_description: "Request body must be JSON",
      },
      400,
    );
  }

  const parsed = RegisterBodySchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      {
        error: "invalid_client_metadata",
        error_description: "Invalid registration request",
        details: parsed.error.flatten(),
      },
      400,
    );
  }

  const data = parsed.data;
  const grantTypes = data.grant_types.filter(
    (g) => g === "authorization_code" || g === "refresh_token",
  );
  if (!grantTypes.includes("authorization_code")) {
    return c.json(
      {
        error: "invalid_client_metadata",
        error_description: "grant_types must include authorization_code",
      },
      400,
    );
  }
  if (!data.response_types.includes("code")) {
    return c.json(
      {
        error: "invalid_client_metadata",
        error_description: "response_types must include code",
      },
      400,
    );
  }

  const issueSecret = data.token_endpoint_auth_method === "client_secret_post";
  const { client, clientSecret } = createOauthClient({
    clientName: data.client_name ?? "MCP Client",
    redirectUris: data.redirect_uris,
    grantTypes,
    tokenEndpointAuthMethod: data.token_endpoint_auth_method,
    issueSecret,
  });

  const response: Record<string, unknown> = {
    client_id: client.clientId,
    client_id_issued_at: Math.floor(client.createdAt.getTime() / 1000),
    client_name: client.clientName,
    redirect_uris: data.redirect_uris,
    grant_types: grantTypes,
    response_types: ["code"],
    token_endpoint_auth_method: data.token_endpoint_auth_method,
    scope: data.scope ?? DEFAULT_SCOPE,
  };
  if (clientSecret) {
    response.client_secret = clientSecret;
  }

  return c.json(response, 201);
}

export function createOauthRegisterRoutes(): Hono {
  const app = new Hono();
  app.post("/oauth/register", (c) => handleRegister(c));
  return app;
}
