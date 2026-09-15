import type { Context } from "hono";
import { Hono } from "hono";
import { setCookie } from "hono/cookie";
import { eq } from "drizzle-orm";
import {
  SESSION_COOKIE,
  SESSION_TTL_MS,
  verifyPassword,
} from "../auth/crypto.js";
import { createSession, purgeExpiredSessions } from "../auth/sessions.js";
import { getSessionUser } from "../auth/routes.js";
import { getDb } from "../db/index.js";
import { users } from "../db/schema.js";
import { getPublicOrigin } from "./metadata.js";
import {
  createAuthCode,
  DEFAULT_SCOPE,
  findClientByClientId,
  parseJsonArray,
} from "./store.js";

type AuthorizeParams = {
  responseType: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  scope: string;
  state: string | null;
  resource: string | null;
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function readAuthorizeParams(
  source: URLSearchParams | Record<string, string>,
): AuthorizeParams | { error: string; description: string } {
  const get = (key: string) => {
    if (source instanceof URLSearchParams) return source.get(key) ?? "";
    return source[key] ?? "";
  };

  const responseType = get("response_type").trim();
  const clientId = get("client_id").trim();
  const redirectUri = get("redirect_uri").trim();
  const codeChallenge = get("code_challenge").trim();
  const codeChallengeMethod = (get("code_challenge_method") || "S256").trim();
  const scope = (get("scope") || DEFAULT_SCOPE).trim() || DEFAULT_SCOPE;
  const state = get("state").trim() || null;
  const resource = get("resource").trim() || null;

  if (responseType !== "code") {
    return {
      error: "unsupported_response_type",
      description: "Only response_type=code is supported",
    };
  }
  if (!clientId) {
    return { error: "invalid_request", description: "client_id is required" };
  }
  if (!redirectUri) {
    return {
      error: "invalid_request",
      description: "redirect_uri is required",
    };
  }
  if (!codeChallenge) {
    return {
      error: "invalid_request",
      description: "code_challenge is required (PKCE)",
    };
  }
  if (codeChallengeMethod !== "S256") {
    return {
      error: "invalid_request",
      description: "Only code_challenge_method=S256 is supported",
    };
  }

  return {
    responseType,
    clientId,
    redirectUri,
    codeChallenge,
    codeChallengeMethod,
    scope,
    state,
    resource,
  };
}

function hiddenFields(params: AuthorizeParams): string {
  const pairs: [string, string][] = [
    ["response_type", params.responseType],
    ["client_id", params.clientId],
    ["redirect_uri", params.redirectUri],
    ["code_challenge", params.codeChallenge],
    ["code_challenge_method", params.codeChallengeMethod],
    ["scope", params.scope],
  ];
  if (params.state) pairs.push(["state", params.state]);
  if (params.resource) pairs.push(["resource", params.resource]);
  return pairs
    .map(
      ([k, v]) =>
        `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}" />`,
    )
    .join("\n");
}

function pageShell(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0f1419; color: #e7ecf3; }
    .card { width: min(420px, 92vw); background: #1a222c; border: 1px solid #2c3744; border-radius: 12px; padding: 1.5rem; }
    h1 { font-size: 1.15rem; margin: 0 0 0.5rem; }
    p { margin: 0 0 1rem; color: #a8b3c2; line-height: 1.45; font-size: 0.95rem; }
    label { display: block; font-size: 0.8rem; margin-bottom: 0.25rem; color: #c5ced9; }
    input[type=text], input[type=password] {
      width: 100%; box-sizing: border-box; margin-bottom: 0.85rem;
      padding: 0.55rem 0.7rem; border-radius: 8px; border: 1px solid #3a4756;
      background: #121820; color: inherit;
    }
    .actions { display: flex; gap: 0.6rem; margin-top: 0.5rem; }
    button {
      flex: 1; padding: 0.6rem 0.8rem; border-radius: 8px; border: 0; cursor: pointer;
      font-weight: 600;
    }
    button.primary { background: #3d8bfd; color: #fff; }
    button.secondary { background: #2a3440; color: #e7ecf3; }
    .error { color: #ff8f8f; margin-bottom: 0.85rem; font-size: 0.9rem; }
  </style>
</head>
<body>
  <div class="card">${body}</div>
</body>
</html>`;
}

function loginPage(params: AuthorizeParams, error?: string): string {
  return pageShell(
    "Sign in — Yūsetu",
    `
    <h1>Sign in to Yūsetu</h1>
    <p>Sign in to authorize an MCP client.</p>
    ${error ? `<div class="error">${escapeHtml(error)}</div>` : ""}
    <form method="post" action="/oauth/authorize">
      ${hiddenFields(params)}
      <input type="hidden" name="action" value="login" />
      <label for="username">Username</label>
      <input id="username" name="username" type="text" autocomplete="username" required />
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required />
      <div class="actions">
        <button class="primary" type="submit">Sign in</button>
      </div>
    </form>`,
  );
}

function consentPage(
  params: AuthorizeParams,
  clientName: string,
  username: string,
): string {
  return pageShell(
    "Authorize — Yūsetu",
    `
    <h1>Allow access?</h1>
    <p><strong>${escapeHtml(clientName)}</strong> wants to access Yūsetu MCP as <strong>${escapeHtml(username)}</strong>.</p>
    <p>Scope: <code>${escapeHtml(params.scope)}</code></p>
    <form method="post" action="/oauth/authorize" style="margin-bottom:0.6rem">
      ${hiddenFields(params)}
      <input type="hidden" name="action" value="approve" />
      <div class="actions">
        <button class="primary" type="submit">Allow</button>
      </div>
    </form>
    <form method="post" action="/oauth/authorize">
      ${hiddenFields(params)}
      <input type="hidden" name="action" value="deny" />
      <div class="actions">
        <button class="secondary" type="submit">Deny</button>
      </div>
    </form>`,
  );
}

function validateClientAndRedirect(
  params: AuthorizeParams,
  origin: string,
):
  | { ok: true; clientName: string; resource: string | null }
  | { ok: false; status: 400; body: { error: string; error_description: string } } {
  const client = findClientByClientId(params.clientId);
  if (!client) {
    return {
      ok: false,
      status: 400,
      body: {
        error: "invalid_client",
        error_description: "Unknown client_id",
      },
    };
  }

  const redirectUris = parseJsonArray(client.redirectUrisJson);
  if (!redirectUris.includes(params.redirectUri)) {
    return {
      ok: false,
      status: 400,
      body: {
        error: "invalid_request",
        error_description: "redirect_uri is not registered for this client",
      },
    };
  }

  const expectedResource = `${origin}/mcp`;
  const resource = params.resource ?? expectedResource;
  if (resource !== expectedResource) {
    return {
      ok: false,
      status: 400,
      body: {
        error: "invalid_target",
        error_description: `resource must be ${expectedResource}`,
      },
    };
  }

  return { ok: true, clientName: client.clientName, resource };
}

function redirectWithError(
  redirectUri: string,
  error: string,
  description: string,
  state: string | null,
): Response {
  const url = new URL(redirectUri);
  url.searchParams.set("error", error);
  url.searchParams.set("error_description", description);
  if (state) url.searchParams.set("state", state);
  return Response.redirect(url.toString(), 302);
}

function setSessionCookie(c: Context, token: string): void {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
    secure: c.req.url.startsWith("https://"),
  });
}

async function handleAuthorizeGet(c: Context) {
  const paramsOrErr = readAuthorizeParams(c.req.query());
  if ("error" in paramsOrErr) {
    return c.json(
      {
        error: paramsOrErr.error,
        error_description: paramsOrErr.description,
      },
      400,
    );
  }
  const params = paramsOrErr;
  const origin = getPublicOrigin(c);
  const validated = validateClientAndRedirect(params, origin);
  if (!validated.ok) {
    return c.json(validated.body, validated.status);
  }

  const user = getSessionUser(c);
  if (!user) {
    return c.html(loginPage(params));
  }

  return c.html(consentPage(params, validated.clientName, user.username));
}

async function handleAuthorizePost(c: Context) {
  const form = await c.req.parseBody();
  const asStrings: Record<string, string> = {};
  for (const [k, v] of Object.entries(form)) {
    if (typeof v === "string") asStrings[k] = v;
  }

  const paramsOrErr = readAuthorizeParams(asStrings);
  if ("error" in paramsOrErr) {
    return c.json(
      {
        error: paramsOrErr.error,
        error_description: paramsOrErr.description,
      },
      400,
    );
  }
  const params = paramsOrErr;
  const origin = getPublicOrigin(c);
  const validated = validateClientAndRedirect(params, origin);
  if (!validated.ok) {
    return c.json(validated.body, validated.status);
  }

  const action = (asStrings.action ?? "").trim();

  if (action === "login") {
    purgeExpiredSessions();
    const username = (asStrings.username ?? "").trim();
    const password = asStrings.password ?? "";
    const db = getDb();
    const user = db
      .select()
      .from(users)
      .where(eq(users.username, username))
      .get();

    if (!user || !(await verifyPassword(user.passwordHash, password))) {
      return c.html(loginPage(params, "Invalid username or password"));
    }

    db.update(users)
      .set({ lastLoginAt: new Date() })
      .where(eq(users.id, user.id))
      .run();

    const token = await createSession(user.id);
    setSessionCookie(c, token);
    return c.html(consentPage(params, validated.clientName, user.username));
  }

  const user = getSessionUser(c);
  if (!user) {
    return c.html(loginPage(params, "Please sign in to continue"));
  }

  if (action === "deny") {
    return redirectWithError(
      params.redirectUri,
      "access_denied",
      "The user denied the request",
      params.state,
    );
  }

  if (action !== "approve") {
    return c.html(consentPage(params, validated.clientName, user.username));
  }

  const { raw } = createAuthCode({
    clientId: params.clientId,
    userId: user.id,
    redirectUri: params.redirectUri,
    codeChallenge: params.codeChallenge,
    codeChallengeMethod: params.codeChallengeMethod,
    resource: validated.resource,
    scopes: params.scope,
  });

  const url = new URL(params.redirectUri);
  url.searchParams.set("code", raw);
  if (params.state) url.searchParams.set("state", params.state);
  return c.redirect(url.toString(), 302);
}

export function createOauthAuthorizeRoutes(): Hono {
  const app = new Hono();
  app.get("/oauth/authorize", (c) => handleAuthorizeGet(c));
  app.post("/oauth/authorize", (c) => handleAuthorizePost(c));
  return app;
}
