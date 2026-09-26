import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  role: text("role", { enum: ["owner", "admin", "member"] })
    .notNull()
    .default("member"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  lastLoginAt: integer("last_login_at", { mode: "timestamp_ms" }),
});

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

export const invites = sqliteTable("invites", {
  id: text("id").primaryKey(),
  tokenHash: text("token_hash").notNull().unique(),
  role: text("role", { enum: ["admin", "member"] }).notNull(),
  createdByUserId: text("created_by_user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  usedAt: integer("used_at", { mode: "timestamp_ms" }),
  usedByUserId: text("used_by_user_id").references(() => users.id, {
    onDelete: "set null",
  }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

export const upstreams = sqliteTable("upstreams", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull(),
  name: text("name").notNull(),
  transport: text("transport", {
    enum: ["stdio", "sse", "streamable-http"],
  }).notNull(),
  command: text("command"),
  argsJson: text("args_json"),
  cwd: text("cwd"),
  url: text("url"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  timeoutMs: integer("timeout_ms").notNull().default(30_000),
  authMode: text("auth_mode", { enum: ["none", "oauth"] })
    .notNull()
    .default("none"),
  /** HTTPS git URL when this stdio MCP is sourced from a git checkout. */
  gitUrl: text("git_url"),
  /** Branch/tag/commit for git checkout; gateway defaults to main when gitUrl set. */
  gitRef: text("git_ref"),
  /** Space-separated one-shot install argv; null/empty = skip install. */
  installCommand: text("install_command"),
  /** host | docker — how stdio processes are launched. */
  isolation: text("isolation", { enum: ["host", "docker"] })
    .notNull()
    .default("host"),
  /** none | bridge — Docker network when isolation=docker. */
  isolationNetwork: text("isolation_network", { enum: ["none", "bridge"] })
    .notNull()
    .default("none"),
  /** Optional Docker image override. */
  isolationImage: text("isolation_image"),
  visibility: text("visibility", { enum: ["shared", "personal"] })
    .notNull()
    .default("personal"),
  /** Required for personal upstreams. Null for shared. */
  ownerUserId: text("owner_user_id").references(() => users.id, {
    onDelete: "cascade",
  }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  createdByUserId: text("created_by_user_id").references(() => users.id),
});

export const upstreamSecrets = sqliteTable("upstream_secrets", {
  id: text("id").primaryKey(),
  upstreamId: text("upstream_id")
    .notNull()
    .references(() => upstreams.id, { onDelete: "cascade" }),
  keyName: text("key_name").notNull(),
  ciphertext: text("ciphertext").notNull(),
  iv: text("iv").notNull(),
  authTag: text("auth_tag").notNull(),
});

/** Per-user secret overlay on a shared or personal upstream. */
export const userUpstreamSecrets = sqliteTable("user_upstream_secrets", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  upstreamId: text("upstream_id")
    .notNull()
    .references(() => upstreams.id, { onDelete: "cascade" }),
  keyName: text("key_name").notNull(),
  ciphertext: text("ciphertext").notNull(),
  iv: text("iv").notNull(),
  authTag: text("auth_tag").notNull(),
});

/** 1:1 OAuth client state for remote HTTP upstreams (auth_mode=oauth). */
export const upstreamOauth = sqliteTable("upstream_oauth", {
  upstreamId: text("upstream_id")
    .primaryKey()
    .references(() => upstreams.id, { onDelete: "cascade" }),
  /** Registered OAuth client (client_id, optional client_secret, …) as JSON. */
  clientInformationJson: text("client_information_json"),
  /**
   * Encrypted OAuth tokens blob: JSON of { ciphertext, iv, authTag }
   * whose plaintext is OAuthTokens JSON. Requires GATEWAY_MASTER_KEY.
   */
  tokensJson: text("tokens_json"),
  codeVerifier: text("code_verifier"),
  pendingState: text("pending_state"),
  discoveryJson: text("discovery_json"),
  status: text("status", {
    enum: ["disconnected", "pending", "connected", "error"],
  })
    .notNull()
    .default("disconnected"),
  errorMessage: text("error_message"),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

/** Per-user OAuth tokens for shared upstreams. */
export const userUpstreamOauth = sqliteTable("user_upstream_oauth", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  upstreamId: text("upstream_id")
    .notNull()
    .references(() => upstreams.id, { onDelete: "cascade" }),
  clientInformationJson: text("client_information_json"),
  tokensJson: text("tokens_json"),
  codeVerifier: text("code_verifier"),
  pendingState: text("pending_state"),
  discoveryJson: text("discovery_json"),
  status: text("status", {
    enum: ["disconnected", "pending", "connected", "error"],
  })
    .notNull()
    .default("disconnected"),
  errorMessage: text("error_message"),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

/**
 * Allowlist for shared upstream visibility.
 * Empty after migrate (fail-closed). Personal upstreams never use this table.
 */
export const upstreamGrants = sqliteTable("upstream_grants", {
  id: text("id").primaryKey(),
  upstreamId: text("upstream_id")
    .notNull()
    .references(() => upstreams.id, { onDelete: "cascade" }),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

export const tools = sqliteTable("tools", {
  id: text("id").primaryKey(),
  upstreamId: text("upstream_id")
    .notNull()
    .references(() => upstreams.id, { onDelete: "cascade" }),
  originalName: text("original_name").notNull(),
  exposedName: text("exposed_name").notNull(),
  description: text("description"),
  inputSchemaJson: text("input_schema_json"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" }),
});

export const apiKeys = sqliteTable("api_keys", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  keyHash: text("key_hash").notNull(),
  prefix: text("prefix").notNull(),
  userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
});

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

/**
 * Firehose of MCP gateway usage for analytics.
 * kinds: tools_list | list_tools | search_tools | get_tool | tool_call
 */
export const usageEvents = sqliteTable("usage_events", {
  id: text("id").primaryKey(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  kind: text("kind", {
    enum: [
      "tools_list",
      "list_tools",
      "search_tools",
      "get_tool",
      "tool_call",
    ],
  }).notNull(),
  /** Null for gateway-wide tools/list events. */
  mcpSlug: text("mcp_slug"),
  toolName: text("tool_name"),
  /** Estimated tokens for what Yūsetu actually returned/handled. */
  tokensViaGateway: integer("tokens_via_gateway").notNull(),
  /** Counterfactual tokens if those MCP(s) were connected directly. */
  tokensIfDirect: integer("tokens_if_direct").notNull(),
  callCount: integer("call_count").notNull().default(1),
  userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
});

export const oauthClients = sqliteTable("oauth_clients", {
  id: text("id").primaryKey(),
  clientId: text("client_id").notNull().unique(),
  clientSecretHash: text("client_secret_hash"),
  clientName: text("client_name").notNull(),
  redirectUrisJson: text("redirect_uris_json").notNull(),
  grantTypesJson: text("grant_types_json").notNull(),
  tokenEndpointAuthMethod: text("token_endpoint_auth_method").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

export const oauthAuthCodes = sqliteTable("oauth_auth_codes", {
  id: text("id").primaryKey(),
  codeHash: text("code_hash").notNull(),
  clientId: text("client_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  redirectUri: text("redirect_uri").notNull(),
  codeChallenge: text("code_challenge").notNull(),
  codeChallengeMethod: text("code_challenge_method").notNull(),
  resource: text("resource"),
  scopes: text("scopes").notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  usedAt: integer("used_at", { mode: "timestamp_ms" }),
});

export const oauthTokens = sqliteTable("oauth_tokens", {
  id: text("id").primaryKey(),
  tokenType: text("token_type", { enum: ["access", "refresh"] }).notNull(),
  tokenHash: text("token_hash").notNull(),
  clientId: text("client_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  resource: text("resource"),
  scopes: text("scopes").notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  refreshTokenId: text("refresh_token_id"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
});

export type User = typeof users.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type Invite = typeof invites.$inferSelect;
export type Upstream = typeof upstreams.$inferSelect;
export type UpstreamSecret = typeof upstreamSecrets.$inferSelect;
export type UserUpstreamSecret = typeof userUpstreamSecrets.$inferSelect;
export type UpstreamOauth = typeof upstreamOauth.$inferSelect;
export type UserUpstreamOauth = typeof userUpstreamOauth.$inferSelect;
export type UpstreamGrant = typeof upstreamGrants.$inferSelect;
export type Tool = typeof tools.$inferSelect;
export type ApiKey = typeof apiKeys.$inferSelect;
export type Setting = typeof settings.$inferSelect;
export type UsageEvent = typeof usageEvents.$inferSelect;
export type OauthClient = typeof oauthClients.$inferSelect;
export type OauthAuthCode = typeof oauthAuthCodes.$inferSelect;
export type OauthToken = typeof oauthTokens.$inferSelect;
