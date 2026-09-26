import {
  auth,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { and, eq } from "drizzle-orm";
import type { GatewayConfig } from "../config.js";
import { getDb } from "../db/index.js";
import { upstreamOauth, upstreams, userUpstreamOauth } from "../db/schema.js";
import {
  decryptSecret,
  encryptSecret,
  requireMasterKey,
  type EncryptedSecret,
} from "../secrets/crypto.js";

export type UpstreamOauthStatus =
  | "disconnected"
  | "pending"
  | "connected"
  | "error";

function touchRow(
  upstreamId: string,
  patch: Partial<{
    clientInformationJson: string | null;
    tokensJson: string | null;
    codeVerifier: string | null;
    pendingState: string | null;
    discoveryJson: string | null;
    status: UpstreamOauthStatus;
    errorMessage: string | null;
  }>,
): void {
  const db = getDb();
  const existing = db
    .select()
    .from(upstreamOauth)
    .where(eq(upstreamOauth.upstreamId, upstreamId))
    .get();
  const now = new Date();
  if (existing) {
    db.update(upstreamOauth)
      .set({ ...patch, updatedAt: now })
      .where(eq(upstreamOauth.upstreamId, upstreamId))
      .run();
  } else {
    db.insert(upstreamOauth)
      .values({
        upstreamId,
        clientInformationJson: patch.clientInformationJson ?? null,
        tokensJson: patch.tokensJson ?? null,
        codeVerifier: patch.codeVerifier ?? null,
        pendingState: patch.pendingState ?? null,
        discoveryJson: patch.discoveryJson ?? null,
        status: patch.status ?? "disconnected",
        errorMessage: patch.errorMessage ?? null,
        updatedAt: now,
      })
      .run();
  }
}

export function ensureUpstreamOauthRow(upstreamId: string): void {
  const db = getDb();
  const existing = db
    .select()
    .from(upstreamOauth)
    .where(eq(upstreamOauth.upstreamId, upstreamId))
    .get();
  if (!existing) {
    db.insert(upstreamOauth)
      .values({
        upstreamId,
        status: "disconnected",
        updatedAt: new Date(),
      })
      .run();
  }
}

export function getUpstreamOauthRow(upstreamId: string) {
  return getDb()
    .select()
    .from(upstreamOauth)
    .where(eq(upstreamOauth.upstreamId, upstreamId))
    .get();
}

export function getUserUpstreamOauthRow(userId: string, upstreamId: string) {
  return getDb()
    .select()
    .from(userUpstreamOauth)
    .where(
      and(
        eq(userUpstreamOauth.userId, userId),
        eq(userUpstreamOauth.upstreamId, upstreamId),
      ),
    )
    .get();
}

function ensureUserUpstreamOauthRow(userId: string, upstreamId: string): void {
  const db = getDb();
  const existing = getUserUpstreamOauthRow(userId, upstreamId);
  if (!existing) {
    db.insert(userUpstreamOauth)
      .values({
        id: crypto.randomUUID(),
        userId,
        upstreamId,
        status: "disconnected",
        updatedAt: new Date(),
      })
      .run();
  }
}

function touchUserOauthRow(
  userId: string,
  upstreamId: string,
  patch: Partial<{
    clientInformationJson: string | null;
    tokensJson: string | null;
    codeVerifier: string | null;
    pendingState: string | null;
    discoveryJson: string | null;
    status: UpstreamOauthStatus;
    errorMessage: string | null;
  }>,
): void {
  ensureUserUpstreamOauthRow(userId, upstreamId);
  const db = getDb();
  const now = new Date();
  db.update(userUpstreamOauth)
    .set({ ...patch, updatedAt: now })
    .where(
      and(
        eq(userUpstreamOauth.userId, userId),
        eq(userUpstreamOauth.upstreamId, upstreamId),
      ),
    )
    .run();
}

function decryptTokensJson(
  tokensJson: string | null | undefined,
  masterKey: string,
): OAuthTokens | undefined {
  if (!tokensJson) return undefined;
  try {
    const enc = JSON.parse(tokensJson) as EncryptedSecret;
    const plaintext = decryptSecret(enc, masterKey);
    return JSON.parse(plaintext) as OAuthTokens;
  } catch {
    return undefined;
  }
}

export function findUpstreamOauthByState(state: string) {
  return getDb()
    .select()
    .from(upstreamOauth)
    .where(eq(upstreamOauth.pendingState, state))
    .get();
}

export function clearUpstreamOauthTokens(upstreamId: string): void {
  touchRow(upstreamId, {
    tokensJson: null,
    codeVerifier: null,
    pendingState: null,
    status: "disconnected",
    errorMessage: null,
  });
}

export function setUpstreamOauthStatus(
  upstreamId: string,
  status: UpstreamOauthStatus,
  errorMessage?: string | null,
): void {
  touchRow(upstreamId, {
    status,
    errorMessage: errorMessage ?? null,
  });
}

/**
 * OAuthClientProvider backed by `upstream_oauth`.
 * Tokens are AES-GCM encrypted with GATEWAY_MASTER_KEY and stored in tokens_json.
 */
export class UpstreamOAuthProvider implements OAuthClientProvider {
  readonly #upstreamId: string;
  readonly #userId: string | undefined;
  readonly #publicOrigin: string;
  readonly #masterKey: string;
  #pendingAuthorizationUrl: URL | undefined;
  #generatedState: string | undefined;

  constructor(opts: {
    upstreamId: string;
    publicOrigin: string;
    masterKeyBase64: string;
    userId?: string;
  }) {
    this.#upstreamId = opts.upstreamId;
    this.#userId = opts.userId;
    this.#publicOrigin = opts.publicOrigin.replace(/\/$/, "");
    this.#masterKey = requireMasterKey(opts.masterKeyBase64);
    ensureUpstreamOauthRow(opts.upstreamId);
    if (opts.userId) {
      ensureUserUpstreamOauthRow(opts.userId, opts.upstreamId);
    }
  }

  get redirectUrl(): string {
    return `${this.#publicOrigin}/oauth/upstream/callback`;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "Yusetu Gateway",
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  /** Captured by redirectToAuthorization — returned to the dashboard start API. */
  get pendingAuthorizationUrl(): URL | undefined {
    return this.#pendingAuthorizationUrl;
  }

  async state(): Promise<string> {
    if (!this.#generatedState) {
      this.#generatedState = crypto.randomUUID();
      touchRow(this.#upstreamId, {
        pendingState: this.#generatedState,
        status: "pending",
        errorMessage: null,
      });
    }
    return this.#generatedState;
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    const row = getUpstreamOauthRow(this.#upstreamId);
    if (!row?.clientInformationJson) return undefined;
    try {
      return JSON.parse(row.clientInformationJson) as OAuthClientInformationMixed;
    } catch {
      return undefined;
    }
  }

  async saveClientInformation(
    clientInformation: OAuthClientInformationMixed,
  ): Promise<void> {
    touchRow(this.#upstreamId, {
      clientInformationJson: JSON.stringify(clientInformation),
    });
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    if (this.#userId) {
      const userRow = getUserUpstreamOauthRow(this.#userId, this.#upstreamId);
      const fromUser = decryptTokensJson(userRow?.tokensJson, this.#masterKey);
      if (fromUser) return fromUser;
    }
    const row = getUpstreamOauthRow(this.#upstreamId);
    return decryptTokensJson(row?.tokensJson, this.#masterKey);
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    const enc = encryptSecret(JSON.stringify(tokens), this.#masterKey);
    const patch = {
      tokensJson: JSON.stringify(enc),
      codeVerifier: null,
      pendingState: null,
      status: "connected" as const,
      errorMessage: null,
    };
    if (this.#userId) {
      touchUserOauthRow(this.#userId, this.#upstreamId, patch);
      return;
    }
    touchRow(this.#upstreamId, patch);
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    this.#pendingAuthorizationUrl = authorizationUrl;
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    touchRow(this.#upstreamId, { codeVerifier });
  }

  async codeVerifier(): Promise<string> {
    if (this.#userId) {
      const userRow = getUserUpstreamOauthRow(this.#userId, this.#upstreamId);
      if (userRow?.codeVerifier) return userRow.codeVerifier;
    }
    const row = getUpstreamOauthRow(this.#upstreamId);
    if (!row?.codeVerifier) {
      throw new Error("Missing PKCE code_verifier for upstream OAuth");
    }
    return row.codeVerifier;
  }

  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    touchRow(this.#upstreamId, {
      discoveryJson: JSON.stringify(state),
    });
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    const row = getUpstreamOauthRow(this.#upstreamId);
    if (!row?.discoveryJson) return undefined;
    try {
      return JSON.parse(row.discoveryJson) as OAuthDiscoveryState;
    } catch {
      return undefined;
    }
  }

  async invalidateCredentials(
    scope: "all" | "client" | "tokens" | "verifier" | "discovery",
  ): Promise<void> {
    if (scope === "all") {
      touchRow(this.#upstreamId, {
        clientInformationJson: null,
        tokensJson: null,
        codeVerifier: null,
        pendingState: null,
        discoveryJson: null,
        status: "disconnected",
        errorMessage: null,
      });
      return;
    }
    if (scope === "client") {
      touchRow(this.#upstreamId, { clientInformationJson: null });
      return;
    }
    if (scope === "tokens") {
      touchRow(this.#upstreamId, {
        tokensJson: null,
        status: "disconnected",
      });
      return;
    }
    if (scope === "verifier") {
      touchRow(this.#upstreamId, { codeVerifier: null });
      return;
    }
    if (scope === "discovery") {
      touchRow(this.#upstreamId, { discoveryJson: null });
    }
  }
}

export function createUpstreamOAuthProvider(
  upstreamId: string,
  publicOrigin: string,
  config: GatewayConfig,
  userId?: string,
): UpstreamOAuthProvider {
  return new UpstreamOAuthProvider({
    upstreamId,
    publicOrigin,
    masterKeyBase64: requireMasterKey(config.masterKeyBase64),
    userId,
  });
}

export async function startUpstreamOAuth(
  provider: UpstreamOAuthProvider,
  serverUrl: string,
): Promise<{ result: "AUTHORIZED" | "REDIRECT"; authorizationUrl?: string }> {
  const result = await auth(provider, { serverUrl });
  if (result === "REDIRECT") {
    const url = provider.pendingAuthorizationUrl;
    if (!url) {
      throw new Error("OAuth redirect requested but no authorization URL captured");
    }
    return { result, authorizationUrl: url.toString() };
  }
  return { result };
}

export async function completeUpstreamOAuth(
  provider: UpstreamOAuthProvider,
  serverUrl: string,
  authorizationCode: string,
): Promise<void> {
  const result = await auth(provider, {
    serverUrl,
    authorizationCode,
  });
  if (result !== "AUTHORIZED") {
    throw new Error("OAuth authorization code exchange did not complete");
  }
}

export function resolvePublicOrigin(
  config: GatewayConfig,
  requestOrigin: string,
): string {
  if (config.publicOrigin) {
    return config.publicOrigin.replace(/\/$/, "");
  }
  return requestOrigin.replace(/\/$/, "");
}

export function dashboardRedirectAfterOauth(
  requestOrigin: string,
  referer: string | undefined,
  query: "connected" | "error" = "connected",
): string {
  const path = `/mcps?oauth=${query}`;
  if (referer) {
    try {
      const ref = new URL(referer);
      if (ref.port === "5173") {
        return `${ref.protocol}//${ref.hostname}:5173${path}`;
      }
    } catch {
      /* ignore */
    }
  }
  return `${requestOrigin.replace(/\/$/, "")}${path}`;
}

export function requireHttpOauthUpstream(upstreamId: string):
  | { ok: true; upstream: typeof upstreams.$inferSelect & { url: string } }
  | { ok: false; error: string; status: 404 | 400 } {
  const db = getDb();
  const upstream = db
    .select()
    .from(upstreams)
    .where(eq(upstreams.id, upstreamId))
    .get();
  if (!upstream) {
    return { ok: false, error: "Not found", status: 404 };
  }
  if (upstream.authMode !== "oauth") {
    return {
      ok: false,
      error: "Upstream auth_mode is not oauth",
      status: 400,
    };
  }
  if (upstream.transport === "stdio" || !upstream.url) {
    return {
      ok: false,
      error: "OAuth requires an HTTP upstream with a URL",
      status: 400,
    };
  }
  return { ok: true, upstream: { ...upstream, url: upstream.url } };
}
