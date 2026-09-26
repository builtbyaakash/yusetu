import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import path from "node:path";
import * as schema from "./schema.js";
import { migrateGrantsV1 } from "./migrate-grants.js";
import { migrateTeamsV1 } from "./migrate-teams.js";

export type Db = BetterSQLite3Database<typeof schema>;

let dbInstance: Db | undefined;
let sqliteInstance: Database.Database | undefined;

const BOOT_SQL = `
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY NOT NULL,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  created_at INTEGER NOT NULL,
  last_login_at INTEGER
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS invites (
  id TEXT PRIMARY KEY NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL,
  created_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  used_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS upstreams (
  id TEXT PRIMARY KEY NOT NULL,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  transport TEXT NOT NULL,
  command TEXT,
  args_json TEXT,
  cwd TEXT,
  url TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  timeout_ms INTEGER NOT NULL DEFAULT 30000,
  auth_mode TEXT NOT NULL DEFAULT 'none',
  git_url TEXT,
  git_ref TEXT,
  install_command TEXT,
  isolation TEXT NOT NULL DEFAULT 'host',
  isolation_network TEXT NOT NULL DEFAULT 'none',
  isolation_image TEXT,
  visibility TEXT NOT NULL DEFAULT 'shared',
  owner_user_id TEXT,
  created_at INTEGER NOT NULL,
  created_by_user_id TEXT REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS upstream_secrets (
  id TEXT PRIMARY KEY NOT NULL,
  upstream_id TEXT NOT NULL REFERENCES upstreams(id) ON DELETE CASCADE,
  key_name TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  auth_tag TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_upstream_secrets (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  upstream_id TEXT NOT NULL REFERENCES upstreams(id) ON DELETE CASCADE,
  key_name TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  auth_tag TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS upstream_oauth (
  upstream_id TEXT PRIMARY KEY NOT NULL REFERENCES upstreams(id) ON DELETE CASCADE,
  client_information_json TEXT,
  tokens_json TEXT,
  code_verifier TEXT,
  pending_state TEXT,
  discovery_json TEXT,
  status TEXT NOT NULL DEFAULT 'disconnected',
  error_message TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS user_upstream_oauth (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  upstream_id TEXT NOT NULL REFERENCES upstreams(id) ON DELETE CASCADE,
  client_information_json TEXT,
  tokens_json TEXT,
  code_verifier TEXT,
  pending_state TEXT,
  discovery_json TEXT,
  status TEXT NOT NULL DEFAULT 'disconnected',
  error_message TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS upstream_grants (
  id TEXT PRIMARY KEY NOT NULL,
  upstream_id TEXT NOT NULL REFERENCES upstreams(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tools (
  id TEXT PRIMARY KEY NOT NULL,
  upstream_id TEXT NOT NULL REFERENCES upstreams(id) ON DELETE CASCADE,
  original_name TEXT NOT NULL,
  exposed_name TEXT NOT NULL,
  description TEXT,
  input_schema_json TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_seen_at INTEGER
);

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  prefix TEXT NOT NULL,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS usage_events (
  id TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  mcp_slug TEXT,
  tool_name TEXT,
  tokens_via_gateway INTEGER NOT NULL,
  tokens_if_direct INTEGER NOT NULL,
  call_count INTEGER NOT NULL DEFAULT 1,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS oauth_clients (
  id TEXT PRIMARY KEY NOT NULL,
  client_id TEXT NOT NULL UNIQUE,
  client_secret_hash TEXT,
  client_name TEXT NOT NULL,
  redirect_uris_json TEXT NOT NULL,
  grant_types_json TEXT NOT NULL,
  token_endpoint_auth_method TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_auth_codes (
  id TEXT PRIMARY KEY NOT NULL,
  code_hash TEXT NOT NULL,
  client_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  code_challenge_method TEXT NOT NULL,
  resource TEXT,
  scopes TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);

CREATE TABLE IF NOT EXISTS oauth_tokens (
  id TEXT PRIMARY KEY NOT NULL,
  token_type TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  client_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  resource TEXT,
  scopes TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  refresh_token_id TEXT,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_sessions_token_hash ON sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_tools_upstream_id ON tools(upstream_id);
CREATE INDEX IF NOT EXISTS idx_tools_exposed_name ON tools(exposed_name);
CREATE INDEX IF NOT EXISTS idx_upstream_secrets_upstream_id ON upstream_secrets(upstream_id);
CREATE INDEX IF NOT EXISTS idx_upstream_oauth_pending_state ON upstream_oauth(pending_state);
CREATE INDEX IF NOT EXISTS idx_oauth_clients_client_id ON oauth_clients(client_id);
CREATE INDEX IF NOT EXISTS idx_oauth_auth_codes_code_hash ON oauth_auth_codes(code_hash);
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_token_hash ON oauth_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_usage_events_created_at ON usage_events(created_at);
CREATE INDEX IF NOT EXISTS idx_usage_events_kind ON usage_events(kind);
CREATE INDEX IF NOT EXISTS idx_usage_events_mcp_slug ON usage_events(mcp_slug);
CREATE INDEX IF NOT EXISTS idx_invites_token_hash ON invites(token_hash);
CREATE INDEX IF NOT EXISTS idx_user_upstream_secrets_user_upstream
  ON user_upstream_secrets(user_id, upstream_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_upstream_oauth_user_upstream
  ON user_upstream_oauth(user_id, upstream_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_upstream_grants_upstream_user
  ON upstream_grants(upstream_id, user_id);
CREATE INDEX IF NOT EXISTS idx_upstream_grants_user_id
  ON upstream_grants(user_id);
`;

/** Light migrations for existing DBs created before schema additions. */
function migrateSchema(sqlite: Database.Database, dataDir: string): void {
  const upstreamCols = sqlite
    .prepare("PRAGMA table_info(upstreams)")
    .all() as Array<{ name: string }>;
  if (!upstreamCols.some((c) => c.name === "auth_mode")) {
    sqlite.exec(
      `ALTER TABLE upstreams ADD COLUMN auth_mode TEXT NOT NULL DEFAULT 'none'`,
    );
  }
  if (!upstreamCols.some((c) => c.name === "git_url")) {
    sqlite.exec(`ALTER TABLE upstreams ADD COLUMN git_url TEXT`);
  }
  if (!upstreamCols.some((c) => c.name === "git_ref")) {
    sqlite.exec(`ALTER TABLE upstreams ADD COLUMN git_ref TEXT`);
  }
  if (!upstreamCols.some((c) => c.name === "install_command")) {
    sqlite.exec(`ALTER TABLE upstreams ADD COLUMN install_command TEXT`);
  }
  if (!upstreamCols.some((c) => c.name === "isolation")) {
    sqlite.exec(
      `ALTER TABLE upstreams ADD COLUMN isolation TEXT NOT NULL DEFAULT 'host'`,
    );
  }
  if (!upstreamCols.some((c) => c.name === "isolation_network")) {
    sqlite.exec(
      `ALTER TABLE upstreams ADD COLUMN isolation_network TEXT NOT NULL DEFAULT 'none'`,
    );
  }
  if (!upstreamCols.some((c) => c.name === "isolation_image")) {
    sqlite.exec(`ALTER TABLE upstreams ADD COLUMN isolation_image TEXT`);
  }

  sqlite.exec(`
CREATE TABLE IF NOT EXISTS upstream_oauth (
  upstream_id TEXT PRIMARY KEY NOT NULL REFERENCES upstreams(id) ON DELETE CASCADE,
  client_information_json TEXT,
  tokens_json TEXT,
  code_verifier TEXT,
  pending_state TEXT,
  discovery_json TEXT,
  status TEXT NOT NULL DEFAULT 'disconnected',
  error_message TEXT,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_upstream_oauth_pending_state ON upstream_oauth(pending_state);
`);

  sqlite.exec(`
CREATE TABLE IF NOT EXISTS usage_events (
  id TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  mcp_slug TEXT,
  tool_name TEXT,
  tokens_via_gateway INTEGER NOT NULL,
  tokens_if_direct INTEGER NOT NULL,
  call_count INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_usage_events_created_at ON usage_events(created_at);
CREATE INDEX IF NOT EXISTS idx_usage_events_kind ON usage_events(kind);
CREATE INDEX IF NOT EXISTS idx_usage_events_mcp_slug ON usage_events(mcp_slug);
`);

  migrateTeamsV1(sqlite, dataDir);
  migrateGrantsV1(sqlite);
}

export function openDb(dbPath: string): Db {
  const sqlite = new Database(dbPath);
  const dataDir = path.dirname(path.resolve(dbPath));
  sqlite.exec(BOOT_SQL);
  migrateSchema(sqlite, dataDir);
  const db = drizzle(sqlite, { schema });
  sqliteInstance = sqlite;
  dbInstance = db;
  return db;
}

export function getDb(): Db {
  if (!dbInstance) {
    throw new Error("Database not initialized");
  }
  return dbInstance;
}

/** Raw better-sqlite3 handle (FTS5 / pragmas). */
export function getSqlite(): Database.Database {
  if (!sqliteInstance) {
    throw new Error("Database not initialized");
  }
  return sqliteInstance;
}

export function closeDb(): void {
  sqliteInstance?.close();
  sqliteInstance = undefined;
  dbInstance = undefined;
}
