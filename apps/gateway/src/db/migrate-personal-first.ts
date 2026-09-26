import type Database from "better-sqlite3";

const PERSONAL_FIRST_FLAG = "schema_personal_first_v1";

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

/**
 * Soft-migrate shared upstreams that have zero grant rows to personal.
 * owner_user_id = created_by_user_id when set; otherwise leave shared.
 * Idempotent via schema_personal_first_v1.
 */
export function migratePersonalFirstV1(sqlite: Database.Database): void {
  if (settingGet(sqlite, PERSONAL_FIRST_FLAG) === "1") {
    return;
  }

  const candidates = sqlite
    .prepare(
      `SELECT u.id, u.created_by_user_id
       FROM upstreams u
       WHERE u.visibility = 'shared'
         AND NOT EXISTS (
           SELECT 1 FROM upstream_grants g WHERE g.upstream_id = u.id
         )`,
    )
    .all() as { id: string; created_by_user_id: string | null }[];

  const update = sqlite.prepare(
    `UPDATE upstreams
     SET visibility = 'personal', owner_user_id = ?
     WHERE id = ?`,
  );

  let converted = 0;
  const tx = sqlite.transaction(() => {
    for (const row of candidates) {
      if (!row.created_by_user_id) continue;
      update.run(row.created_by_user_id, row.id);
      converted += 1;
    }
  });
  tx();

  settingSet(sqlite, PERSONAL_FIRST_FLAG, "1");
  console.info(
    `[yusetu] personal-first migration complete (converted ${converted} zero-grant shared upstreams)`,
  );
}
