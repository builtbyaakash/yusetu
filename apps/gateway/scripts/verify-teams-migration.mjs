/**
 * Verifies teams v1 migration: empty DB, single-user upgrade, checkout move.
 * Run: pnpm --filter @yusetu/gateway exec tsx scripts/verify-teams-migration.mjs
 */
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const gatewayRoot = path.resolve(__dirname, "..");

async function loadOpenDb() {
  const mod = await import(path.join(gatewayRoot, "src/db/index.ts"));
  return mod;
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function createLegacyDb(dbPath) {
  const sqlite = new Database(dbPath);
  sqlite.exec(`
PRAGMA foreign_keys = ON;
CREATE TABLE users (
  id TEXT PRIMARY KEY NOT NULL,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_login_at INTEGER
);
CREATE TABLE upstreams (
  id TEXT PRIMARY KEY NOT NULL,
  slug TEXT NOT NULL UNIQUE,
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
  created_at INTEGER NOT NULL,
  created_by_user_id TEXT REFERENCES users(id)
);
CREATE TABLE tools (
  id TEXT PRIMARY KEY NOT NULL,
  upstream_id TEXT NOT NULL REFERENCES upstreams(id) ON DELETE CASCADE,
  original_name TEXT NOT NULL,
  exposed_name TEXT NOT NULL UNIQUE,
  description TEXT,
  input_schema_json TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_seen_at INTEGER
);
CREATE TABLE api_keys (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  prefix TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE settings (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
`);
  const now = Date.now();
  const userId = "user-owner-1";
  sqlite
    .prepare(
      `INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)`,
    )
    .run(userId, "owner", "hash", now);
  const cwd = path.join(path.dirname(dbPath), "mcp-sources", "demo");
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(path.join(cwd, "marker.txt"), "ok");
  sqlite
    .prepare(
      `INSERT INTO upstreams (
        id, slug, name, transport, cwd, enabled, timeout_ms, auth_mode,
        isolation, isolation_network, created_at, created_by_user_id
      ) VALUES (?, ?, ?, ?, ?, 1, 30000, 'none', 'host', 'none', ?, ?)`,
    )
    .run("up-1", "demo", "Demo", "stdio", cwd, now, userId);
  sqlite
    .prepare(
      `INSERT INTO api_keys (id, name, key_hash, prefix, created_at, enabled)
       VALUES (?, ?, ?, ?, ?, 1)`,
    )
    .run("key-1", "default", "hash", "ysk_test", now);
  sqlite.close();
  return { userId, cwd };
}

async function main() {
  const { openDb, closeDb, getSqlite } = await loadOpenDb();

  // Case 1: empty / fresh DB
  const freshDir = fs.mkdtempSync(path.join(os.tmpdir(), "yusetu-teams-fresh-"));
  const freshDb = path.join(freshDir, "gateway.db");
  openDb(freshDb);
  const freshSqlite = getSqlite();
  const flag = freshSqlite
    .prepare(`SELECT value FROM settings WHERE key = 'schema_teams_v1'`)
    .get();
  assert(flag?.value === "1", "fresh DB should set schema_teams_v1");
  closeDb();
  fs.rmSync(freshDir, { recursive: true, force: true });

  // Case 2: legacy single-user upgrade + checkout move
  const legacyDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "yusetu-teams-legacy-"),
  );
  const legacyDb = path.join(legacyDir, "gateway.db");
  const { userId } = createLegacyDb(legacyDb);
  openDb(legacyDb);
  const sqlite = getSqlite();
  const role = sqlite
    .prepare(`SELECT role FROM users WHERE id = ?`)
    .get(userId);
  assert(role?.role === "owner", "legacy user becomes owner");
  const upstream = sqlite
    .prepare(`SELECT visibility, owner_user_id, cwd FROM upstreams WHERE id = 'up-1'`)
    .get();
  assert(upstream?.visibility === "shared", "upstream visibility shared");
  assert(upstream?.owner_user_id == null, "shared owner_user_id null");
  const expectedCwd = path.join(legacyDir, "mcp-sources", userId, "demo");
  assert(
    upstream?.cwd === expectedCwd,
    `cwd should be ${expectedCwd}, got ${upstream?.cwd}`,
  );
  assert(fs.existsSync(path.join(expectedCwd, "marker.txt")), "checkout moved");
  const key = sqlite.prepare(`SELECT user_id FROM api_keys WHERE id = 'key-1'`).get();
  assert(key?.user_id === userId, "api key bound to owner");

  // Case 3: idempotent second open
  closeDb();
  openDb(legacyDb);
  assert(fs.existsSync(path.join(expectedCwd, "marker.txt")), "checkout stable");
  closeDb();
  fs.rmSync(legacyDir, { recursive: true, force: true });

  console.log("verify-teams-migration: ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
