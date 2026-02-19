import { getDb } from './database';

export type FeaturedMovie = {
  tmdb_id: number | null;
  title: string | null;
  overview: string | null;
  backdrop_path: string | null;
  poster_path: string | null;
  updated_at: string | null;
};

function nowIso() {
  return new Date().toISOString();
}

export async function getFeaturedMovie(): Promise<FeaturedMovie | null> {
  const db = await getDb();
  return db.getFirstAsync<FeaturedMovie>('SELECT * FROM featured_movie WHERE id = 1');
}

export async function setFeaturedMovie(input: {
  tmdbId?: number | null;
  title?: string | null;
  overview?: string | null;
  backdropPath?: string | null;
  posterPath?: string | null;
}) {
  const db = await getDb();
  await db.runAsync(
    `
    INSERT OR REPLACE INTO featured_movie
      (id, tmdb_id, title, overview, backdrop_path, poster_path, updated_at)
    VALUES
      (1, ?, ?, ?, ?, ?, ?)
    `,
    input.tmdbId ?? null,
    input.title ?? null,
    input.overview ?? null,
    input.backdropPath ?? null,
    input.posterPath ?? null,
    nowIso()
  );
}

export async function clearFeaturedMovie() {
  const db = await getDb();
  await db.runAsync('DELETE FROM featured_movie WHERE id = 1');
}
