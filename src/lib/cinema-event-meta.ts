import {
  backdropUrl,
  getMovieById,
  getMovieCredits,
  getTvById,
  getTvCredits,
  posterUrl,
  type TmdbCast,
  type TmdbCrew,
} from '@/lib/tmdb';

export type CinemaEventMeta = {
  mediaType: 'movie' | 'tv';
  tmdbId: number;
  title: string;
  tagline: string | null;
  overview: string | null;
  voteAverage: number | null;
  year: string | null;
  runtimeLabel: string | null;
  genres: string[];
  director: string | null;
  cast: string[];
  poster: string | null;
  backdrop: string | null;
};

function normalizeYear(dateInput: unknown) {
  const value = String(dateInput ?? '').trim();
  if (!value) return null;
  const year = value.slice(0, 4);
  return /^\d{4}$/.test(year) ? year : null;
}

function pickDirector(crew: TmdbCrew[]) {
  return (
    crew.find((person) => String(person.job ?? '').toLowerCase() === 'director')?.name ??
    crew.find((person) => String(person.department ?? '').toLowerCase() === 'directing')?.name ??
    null
  );
}

function pickCast(cast: TmdbCast[]) {
  return cast
    .map((person) => String(person.name ?? '').trim())
    .filter((name) => !!name)
    .slice(0, 4);
}

function normalizeGenres(details: unknown) {
  const rows = (details as any)?.genres;
  if (!Array.isArray(rows)) return [];
  return rows
    .map((row) => String(row?.name ?? '').trim())
    .filter((name) => !!name)
    .slice(0, 4);
}

function formatRuntimeLabelFromMovie(details: unknown) {
  const runtime = Number((details as any)?.runtime ?? 0);
  if (!Number.isFinite(runtime) || runtime <= 0) return null;
  const hours = Math.floor(runtime / 60);
  const minutes = runtime % 60;
  if (hours <= 0) return `${minutes}m`;
  if (minutes <= 0) return `${hours}h`;
  return `${hours}h ${minutes}m`;
}

function formatRuntimeLabelFromTv(details: unknown) {
  const runtimeList = (details as any)?.episode_run_time;
  const avgRuntime = Array.isArray(runtimeList) && runtimeList.length > 0 ? Number(runtimeList[0]) : 0;
  if (!Number.isFinite(avgRuntime) || avgRuntime <= 0) return null;
  return `~${Math.round(avgRuntime)}m/ep`;
}

export async function getCinemaEventMeta(tmdbIdInput: number): Promise<CinemaEventMeta | null> {
  const tmdbId = Number(tmdbIdInput);
  if (!Number.isFinite(tmdbId) || tmdbId <= 0) return null;

  try {
    const [movie, credits] = await Promise.all([getMovieById(tmdbId), getMovieCredits(tmdbId)]);
    return {
      mediaType: 'movie',
      tmdbId,
      title: String(movie.title ?? '').trim() || `Movie #${tmdbId}`,
      tagline: String((movie as any)?.tagline ?? '').trim() || null,
      overview: String(movie.overview ?? '').trim() || null,
      voteAverage: Number.isFinite(Number(movie.vote_average)) ? Number(movie.vote_average) : null,
      year: normalizeYear((movie as any)?.release_date),
      runtimeLabel: formatRuntimeLabelFromMovie(movie),
      genres: normalizeGenres(movie),
      director: pickDirector(credits.crew ?? []),
      cast: pickCast(credits.cast ?? []),
      poster: posterUrl((movie as any)?.poster_path ?? null, 'w500'),
      backdrop: backdropUrl((movie as any)?.backdrop_path ?? null, 'w780'),
    };
  } catch {
  }

  try {
    const [tv, credits] = await Promise.all([getTvById(tmdbId), getTvCredits(tmdbId)]);
    const creators = Array.isArray((tv as any)?.created_by)
      ? (tv as any).created_by
          .map((person: any) => String(person?.name ?? '').trim())
          .filter((name: string) => !!name)
      : [];
    return {
      mediaType: 'tv',
      tmdbId,
      title: String((tv as any)?.name ?? '').trim() || `TV #${tmdbId}`,
      tagline: String((tv as any)?.tagline ?? '').trim() || null,
      overview: String((tv as any)?.overview ?? '').trim() || null,
      voteAverage: Number.isFinite(Number((tv as any)?.vote_average)) ? Number((tv as any)?.vote_average) : null,
      year: normalizeYear((tv as any)?.first_air_date),
      runtimeLabel: formatRuntimeLabelFromTv(tv),
      genres: normalizeGenres(tv),
      director: creators[0] || pickDirector(credits.crew ?? []),
      cast: pickCast(credits.cast ?? []),
      poster: posterUrl((tv as any)?.poster_path ?? null, 'w500'),
      backdrop: backdropUrl((tv as any)?.backdrop_path ?? null, 'w780'),
    };
  } catch {
    return null;
  }
}

