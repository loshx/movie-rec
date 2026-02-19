import { getDb } from './database';

function nowIso() {
  return new Date().toISOString();
}

export async function getSearchHistory(userId: number, limit = 8): Promise<string[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ query: string }>(
    `
      SELECT query
      FROM user_search_history
      WHERE user_id = ?
      ORDER BY last_used_at DESC
      LIMIT ?
    `,
    userId,
    limit
  );
  return rows.map((row) => row.query);
}

export async function upsertSearchHistory(userId: number, query: string) {
  const clean = query.trim();
  if (!clean) return;
  const db = await getDb();
  await db.runAsync(
    `
      INSERT INTO user_search_history (user_id, query, last_used_at)
      VALUES (?, ?, ?)
      ON CONFLICT(user_id, query)
      DO UPDATE SET last_used_at = excluded.last_used_at
    `,
    userId,
    clean,
    nowIso()
  );
}
