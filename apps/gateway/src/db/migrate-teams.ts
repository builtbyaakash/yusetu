import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";

const TEAMS_SCHEMA_FLAG = "schema_teams_v1";

type ColInfo = { name: string };

function tableCols(sqlite: Database.Database, table: string): ColInfo[] {
  return sqlite.prepare(`PRAGMA table_info(${table})`).all() as ColInfo[];
}

function hasCol(cols: ColInfo[], name: string): boolean {
  return cols.some((c) => c.name === name);
}

function settingGet(sqlite: Database.Database, key: string): string | undefined {
  const row = sqlite
    .prepare(`SELECT value FROM settings WHERE key = ?`)
    .get(key) as { value: string } | undefined;
  return row?.value;
}

function settingSet(sqlite: Database.Database, key: string, value: string): void {
  sqlite
    .prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(key, value);
}

function ensureAdditiveColumns(sqlite: Database.Database): void {
  const userCols = tableCols(sqlite, "users");
  if (!hasCol(userCols, "role")) {
    sqlite.exec(
      `ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'member'`,
    );
  }

  const upstreamCols = tableCols(sqlite, "upstreams");
  if (!hasCol(upstreamCols, "visibility")) {
    sqlite.exec(
      `ALTER TABLE upstreams ADD COLUMN visibility TEXT NOT NULL DEFAULT 'shared'`,
    );
  }
  if (!hasCol(upstreamCols, "owner_user_id")) {
    sqlite.exec(`ALTER TABLE upstreams ADD COLUMN owner_user_id TEXT`);
  }

  const apiKeyCols = tableCols(sqlite, "api_keys");
  if (!hasCol(apiKeyCols, "user_id")) {
    sqlite.exec(`ALTER TABLE api_keys ADD COLUMN user_id TEXT`);
  }

  const usageCols = tableCols(sqlite, "usage_events");
  if (!hasCol(usageCols, "user_id")) {
    sqlite.exec(`ALTER TABLE usage_events ADD COLUMN user_id TEXT`);
  }
}

function ensureTeamsTables(sqlite: Database.Database): void {
  sqlite.exec(`
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
CREATE INDEX IF NOT EXISTS idx_invites_token_hash ON invites(token_hash);

CREATE TABLE IF NOT EXISTS user_upstream_secrets (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  upstream_id TEXT NOT NULL REFERENCES upstreams(id) ON DELETE CASCADE,
  key_name TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  auth_tag TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_user_upstream_secrets_user_upstream
  ON user_upstream_secrets(user_id, upstream_id);

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
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_upstream_oauth_user_upstream
  ON user_upstream_oauth(user_id, upstream_id);
CREATE INDEX IF NOT EXISTS idx_user_upstream_oauth_pending_state
  ON user_upstream_oauth(pending_state);
`);
}

function slugHasTableUnique(sqlite: Database.Database): boolean {
  const rows = sqlite
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'upstreams'`)
    .get() as { sql: string } | undefined;
  if (!rows?.sql) return false;
  return /slug\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i.test(rows.sql);
}

function exposedNameHasTableUnique(sqlite: Database.Database): boolean {
  const rows = sqlite
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tools'`)
    .get() as { sql: string } | undefined;
  if (!rows?.sql) return false;
  return /exposed_name\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i.test(rows.sql);
}

function rebuildUpstreamsDropSlugUnique(sqlite: Database.Database): void {
  if (!slugHasTableUnique(sqlite)) return;

  sqlite.exec("PRAGMA foreign_keys = OFF");
  sqlite.exec(`
CREATE TABLE upstreams_teams_v1 (
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
  created_by_user_id TEXT
);
INSERT INTO upstreams_teams_v1 (
  id, slug, name, transport, command, args_json, cwd, url, enabled, timeout_ms,
  auth_mode, git_url, git_ref, install_command, isolation, isolation_network,
  isolation_image, visibility, owner_user_id, created_at, created_by_user_id
)
SELECT
  id, slug, name, transport, command, args_json, cwd, url, enabled, timeout_ms,
  auth_mode, git_url, git_ref, install_command,
  COALESCE(isolation, 'host'),
  COALESCE(isolation_network, 'none'),
  isolation_image,
  COALESCE(visibility, 'shared'),
  owner_user_id,
  created_at,
  created_by_user_id
FROM upstreams;
DROP TABLE upstreams;
ALTER TABLE upstreams_teams_v1 RENAME TO upstreams;
`);
  sqlite.exec("PRAGMA foreign_keys = ON");
}

function rebuildToolsDropExposedUnique(sqlite: Database.Database): void {
  if (!exposedNameHasTableUnique(sqlite)) return;

  sqlite.exec("PRAGMA foreign_keys = OFF");
  sqlite.exec(`
CREATE TABLE tools_teams_v1 (
  id TEXT PRIMARY KEY NOT NULL,
  upstream_id TEXT NOT NULL,
  original_name TEXT NOT NULL,
  exposed_name TEXT NOT NULL,
  description TEXT,
  input_schema_json TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_seen_at INTEGER
);
INSERT INTO tools_teams_v1
SELECT id, upstream_id, original_name, exposed_name, description,
       input_schema_json, enabled, last_seen_at
FROM tools;
DROP TABLE tools;
ALTER TABLE tools_teams_v1 RENAME TO tools;
`);
  sqlite.exec("PRAGMA foreign_keys = ON");
}

function ensureSlugIndexes(sqlite: Database.Database): void {
  sqlite.exec(`
CREATE UNIQUE INDEX IF NOT EXISTS idx_upstreams_shared_slug
  ON upstreams(slug) WHERE visibility = 'shared';
CREATE UNIQUE INDEX IF NOT EXISTS idx_upstreams_personal_slug
  ON upstreams(owner_user_id, slug) WHERE visibility = 'personal';
CREATE INDEX IF NOT EXISTS idx_tools_upstream_id ON tools(upstream_id);
CREATE INDEX IF NOT EXISTS idx_tools_exposed_name ON tools(exposed_name);
`);
}

function backfillRolesAndOwnership(sqlite: Database.Database): string | null {
  const users = sqlite
    .prepare(`SELECT id FROM users ORDER BY created_at ASC`)
    .all() as Array<{ id: string }>;

  if (users.length === 0) return null;

  const ownerId = users[0]!.id;
  sqlite.prepare(`UPDATE users SET role = 'owner' WHERE id = ?`).run(ownerId);
  if (users.length > 1) {
    const rest = users.slice(1).map((u) => u.id);
    const placeholders = rest.map(() => "?").join(",");
    sqlite
      .prepare(`UPDATE users SET role = 'admin' WHERE id IN (${placeholders})`)
      .run(...rest);
  }

  sqlite
    .prepare(
      `UPDATE upstreams SET visibility = 'shared', owner_user_id = NULL
       WHERE visibility IS NULL OR visibility = '' OR visibility = 'shared'`,
    )
    .run();

  sqlite
    .prepare(
      `UPDATE api_keys SET user_id = ? WHERE user_id IS NULL OR user_id = ''`,
    )
    .run(ownerId);

  return ownerId;
}

function relocateMcpSources(
  sqlite: Database.Database,
  dataDir: string,
  ownerId: string,
): void {
  const sourcesRoot = path.join(dataDir, "mcp-sources");
  if (!fs.existsSync(sourcesRoot)) return;

  const upstreams = sqlite
    .prepare(`SELECT id, slug, cwd FROM upstreams`)
    .all() as Array<{ id: string; slug: string; cwd: string | null }>;

  for (const row of upstreams) {
    const legacyDir = path.join(sourcesRoot, row.slug);
    const ownerDir = path.join(sourcesRoot, ownerId, row.slug);

    if (fs.existsSync(ownerDir)) {
      if (row.cwd !== ownerDir) {
        sqlite
          .prepare(`UPDATE upstreams SET cwd = ? WHERE id = ?`)
          .run(ownerDir, row.id);
      }
      continue;
    }

    if (!fs.existsSync(legacyDir)) continue;

    fs.mkdirSync(path.dirname(ownerDir), { recursive: true });
    fs.renameSync(legacyDir, ownerDir);
    sqlite
      .prepare(`UPDATE upstreams SET cwd = ? WHERE id = ?`)
      .run(ownerDir, row.id);
  }
}

/**
 * Teams v1 schema + data migration. Idempotent.
 * dataDir is the parent of gateway.db (YUSETU_DATA_DIR).
 */
export function migrateTeamsV1(
  sqlite: Database.Database,
  dataDir: string,
): void {
  if (settingGet(sqlite, TEAMS_SCHEMA_FLAG) === "1") {
    // Still ensure additive pieces for DBs flagged early during development.
    ensureAdditiveColumns(sqlite);
    ensureTeamsTables(sqlite);
    ensureSlugIndexes(sqlite);
    return;
  }

  ensureAdditiveColumns(sqlite);
  ensureTeamsTables(sqlite);
  rebuildUpstreamsDropSlugUnique(sqlite);
  rebuildToolsDropExposedUnique(sqlite);
  ensureSlugIndexes(sqlite);

  const ownerId = backfillRolesAndOwnership(sqlite);
  if (ownerId) {
    relocateMcpSources(sqlite, dataDir, ownerId);
  }

  settingSet(sqlite, TEAMS_SCHEMA_FLAG, "1");
  console.info("[yusetu] teams migration complete");
}
