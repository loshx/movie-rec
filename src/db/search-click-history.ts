import { getDb } from './database';

export type SearchClickItem = {
  tmdbId: number;
  mediaType: 'movie' | 'tv';
  title: string;
  posterPath: string | null;
  voteAverage: number;
  lastUsedAt: string;
};

function nowIso() {
  return new Date().toISOString();
}

export async function getSearchClickHistory(userId: number, limit = 12): Promise<SearchClickItem[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<{
    tmdb_id: number;
    media_type: string;
    title: string;
    poster_path: string | null;
    vote_average: number | null;
    last_used_at: string;
  }>(
    `
      SELECT tmdb_id, media_type, title, poster_path, vote_average, last_used_at
      FROM user_search_clicks
      WHERE user_id = ?
      ORDER BY last_used_at DESC
      LIMIT ?
    `,
    userId,
    limit
  );
  return rows.map((row) => ({
    tmdbId: row.tmdb_id,
    mediaType: row.media_type === 'tv' ? 'tv' : 'movie',
    title: row.title,
    posterPath: row.poster_path ?? null,
    voteAverage: row.vote_average ?? 0,
    lastUsedAt: row.last_used_at,
  }));
}

export async function upsertSearchClickHistory(
  userId: number,
  item: {
    tmdbId: number;
    mediaType: 'movie' | 'tv';
    title: string;
    posterPath?: string | null;
    voteAverage?: number;
  }
) {
  const db = await getDb();
  await db.runAsync(
    `
      INSERT INTO user_search_clicks
        (user_id, tmdb_id, media_type, title, poster_path, vote_average, last_used_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, tmdb_id, media_type)
      DO UPDATE SET
        title = excluded.title,
        poster_path = excluded.poster_path,
        vote_average = excluded.vote_average,
        last_used_at = excluded.last_used_at
    `,
    userId,
    item.tmdbId,
    item.mediaType,
    item.title,
    item.posterPath ?? null,
    item.voteAverage ?? 0,
    nowIso()
  );
}
