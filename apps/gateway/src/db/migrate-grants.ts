import type Database from "better-sqlite3";

const GRANTS_SCHEMA_FLAG = "schema_grants_v1";

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

function ensureGrantsTable(sqlite: Database.Database): void {
  sqlite.exec(`
CREATE TABLE IF NOT EXISTS upstream_grants (
  id TEXT PRIMARY KEY NOT NULL,
  upstream_id TEXT NOT NULL REFERENCES upstreams(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_upstream_grants_upstream_user
  ON upstream_grants(upstream_id, user_id);
CREATE INDEX IF NOT EXISTS idx_upstream_grants_user_id
  ON upstream_grants(user_id);
`);
}

/**
 * Grants v1 schema. Idempotent. Creates an empty upstream_grants table.
 * Does not auto-grant existing shared upstreams (fail-closed).
 */
export function migrateGrantsV1(sqlite: Database.Database): void {
  ensureGrantsTable(sqlite);
  if (settingGet(sqlite, GRANTS_SCHEMA_FLAG) === "1") {
    return;
  }
  settingSet(sqlite, GRANTS_SCHEMA_FLAG, "1");
  console.info("[yusetu] grants migration complete (empty upstream_grants)");
}
