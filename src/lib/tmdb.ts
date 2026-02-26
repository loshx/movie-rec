import Constants from 'expo-constants';

const extra = Constants.expoConfig?.extra as
  | {
      EXPO_PUBLIC_TMDB_TOKEN?: string;
      EXPO_PUBLIC_TMDB_API_KEY?: string;
    }
  | undefined;

const TMDB_TOKEN = (
  process.env.EXPO_PUBLIC_TMDB_TOKEN ??
  extra?.EXPO_PUBLIC_TMDB_TOKEN ??
  ''
).trim();
const TMDB_API_KEY = (
  process.env.EXPO_PUBLIC_TMDB_API_KEY ??
  extra?.EXPO_PUBLIC_TMDB_API_KEY ??
  ''
).trim();

const BASE_URL = 'https://api.themoviedb.org/3';
const IMAGE_BASE = 'https://image.tmdb.org/t/p';
const TMDB_REQUEST_TIMEOUT_MS = 9000;

async function tmdbFetch<T>(path: string): Promise<T> {
  if (!TMDB_TOKEN && !TMDB_API_KEY) {
    throw new Error('TMDB token/key is missing.');
  }

  const url = TMDB_TOKEN
    ? `${BASE_URL}${path}`
    : `${BASE_URL}${path}${path.includes('?') ? '&' : '?'}api_key=${TMDB_API_KEY}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TMDB_REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      headers: TMDB_TOKEN
        ? {
            Authorization: `Bearer ${TMDB_TOKEN}`,
            'Content-Type': 'application/json;charset=utf-8',
          }
        : {
            'Content-Type': 'application/json;charset=utf-8',
          },
      signal: controller.signal,
    });
  } catch (err) {
    if ((err as any)?.name === 'AbortError') {
      throw new Error('TMDB request timeout.');
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    throw new Error(`TMDB error: ${res.status}`);
  }

  return res.json() as Promise<T>;
}

export function posterUrl(path?: string | null, size: 'w185' | 'w342' | 'w500' = 'w342') {
  if (!path) return null;
  return `${IMAGE_BASE}/${size}${path}`;
}

export function backdropUrl(path?: string | null, size: 'w780' | 'w1280' = 'w780') {
  if (!path) return null;
  return `${IMAGE_BASE}/${size}${path}`;
}

export function providerLogoUrl(path?: string | null, size: 'w45' | 'w92' | 'w154' = 'w92') {
  if (!path) return null;
  return `${IMAGE_BASE}/${size}${path}`;
}

export async function getPopularMovies(page = 1) {
  return tmdbFetch<{ results: Movie[]; total_pages: number }>(
    `/movie/popular?language=en-US&page=${page}`
  );
}

export async function getTopRatedMovies(page = 1) {
  return tmdbFetch<{ results: Movie[]; total_pages: number }>(
    `/movie/top_rated?language=en-US&page=${page}`
  );
}

export async function getNewMovies(page = 1) {
  return tmdbFetch<{ results: Movie[]; total_pages: number }>(
    `/movie/now_playing?language=en-US&page=${page}`
  );
}

export async function getNewEpisodes(page = 1) {
  return tmdbFetch<{ results: TvShow[]; total_pages: number }>(
    `/tv/on_the_air?language=en-US&page=${page}`
  );
}

export async function getPopularTv(page = 1) {
  return tmdbFetch<{ results: TvShow[]; total_pages: number }>(
    `/tv/popular?language=en-US&page=${page}`
  );
}

export async function getTopRatedTv(page = 1) {
  return tmdbFetch<{ results: TvShow[]; total_pages: number }>(
    `/tv/top_rated?language=en-US&page=${page}`
  );
}

export async function getMovieById(id: number) {
  return tmdbFetch<Movie>(`/movie/${id}?language=en-US`);
}

export async function getTvById(id: number) {
  return tmdbFetch<TvShow>(`/tv/${id}?language=en-US`);
}

export async function getMovieVideos(id: number) {
  return tmdbFetch<{ results: TmdbVideo[] }>(`/movie/${id}/videos?language=en-US`);
}

export async function getTvVideos(id: number) {
  return tmdbFetch<{ results: TmdbVideo[] }>(`/tv/${id}/videos?language=en-US`);
}

export async function getSimilarMovies(id: number, page = 1) {
  return tmdbFetch<{ results: Movie[]; total_pages: number }>(
    `/movie/${id}/similar?language=en-US&page=${page}`
  );
}

export async function getSimilarTv(id: number, page = 1) {
  return tmdbFetch<{ results: TvShow[]; total_pages: number }>(
    `/tv/${id}/similar?language=en-US&page=${page}`
  );
}

export async function getMovieRecommendations(id: number, page = 1) {
  return tmdbFetch<{ results: Movie[]; total_pages: number }>(
    `/movie/${id}/recommendations?language=en-US&page=${page}`
  );
}

export async function getTvRecommendations(id: number, page = 1) {
  return tmdbFetch<{ results: TvShow[]; total_pages: number }>(
    `/tv/${id}/recommendations?language=en-US&page=${page}`
  );
}

export async function getMovieWatchProviders(id: number) {
  return tmdbFetch<{ id: number; results: Record<string, TmdbWatchProviderRegion> }>(
    `/movie/${id}/watch/providers`
  );
}

export async function getTvWatchProviders(id: number) {
  return tmdbFetch<{ id: number; results: Record<string, TmdbWatchProviderRegion> }>(
    `/tv/${id}/watch/providers`
  );
}

export async function getMovieCredits(id: number) {
  return tmdbFetch<{ cast: TmdbCast[]; crew: TmdbCrew[] }>(`/movie/${id}/credits?language=en-US`);
}

export async function getTvCredits(id: number) {
  return tmdbFetch<{ cast: TmdbCast[]; crew: TmdbCrew[] }>(`/tv/${id}/credits?language=en-US`);
}

export async function getPersonById(id: number) {
  return tmdbFetch<TmdbPerson>(`/person/${id}?language=en-US`);
}

export async function getPersonCombinedCredits(id: number) {
  return tmdbFetch<{ cast: TmdbPersonCredit[]; crew: TmdbPersonCredit[] }>(`/person/${id}/combined_credits?language=en-US`);
}

export async function searchMovies(query: string, page = 1) {
  return tmdbFetch<{ results: Movie[]; total_pages: number }>(
    `/search/movie?language=en-US&page=${page}&include_adult=false&query=${encodeURIComponent(query)}`
  );
}

export type SearchMediaResult = {
  id: number;
  media_type: 'movie' | 'tv' | 'person';
  title?: string;
  name?: string;
  overview: string;
  poster_path: string | null;
  profile_path?: string | null;
  backdrop_path: string | null;
  known_for_department?: string;
  vote_average: number;
  release_date?: string;
  first_air_date?: string;
};

export async function searchMulti(query: string, page = 1) {
  return tmdbFetch<{ results: SearchMediaResult[]; total_pages: number }>(
    `/search/multi?language=en-US&page=${page}&include_adult=false&query=${encodeURIComponent(query)}`
  );
}

export type GenreDiscoverOptions = {
  sortBy?:
    | 'popularity.desc'
    | 'vote_average.desc'
    | 'primary_release_date.desc'
    | 'primary_release_date.asc';
  year?: number | null;
};

export async function getMoviesByGenre(genreId: number, page = 1, options: GenreDiscoverOptions = {}) {
  const params = new URLSearchParams();
  params.set('language', 'en-US');
  params.set('sort_by', options.sortBy ?? 'popularity.desc');
  params.set('with_genres', String(genreId));
  params.set('page', String(Math.max(1, Number(page) || 1)));
  const year = Number(options.year ?? 0);
  if (Number.isFinite(year) && year >= 1900 && year <= 2100) {
    params.set('primary_release_year', String(Math.trunc(year)));
  }
  return tmdbFetch<{ results: Movie[]; total_pages: number }>(`/discover/movie?${params.toString()}`);
}

export type Movie = {
  id: number;
  title: string;
  overview: string;
  poster_path: string | null;
  backdrop_path: string | null;
  vote_average: number;
  vote_count?: number;
  popularity?: number;
  release_date: string;
};

export type TvShow = {
  id: number;
  name: string;
  overview: string;
  poster_path: string | null;
  backdrop_path: string | null;
  vote_average: number;
  vote_count?: number;
  popularity?: number;
  first_air_date: string;
};

export type TmdbVideo = {
  id: string;
  key: string;
  name: string;
  site: string;
  type: string;
  official: boolean;
};

export type TmdbCast = {
  id: number;
  name: string;
  profile_path: string | null;
  character?: string;
  order?: number;
};

export type TmdbCrew = {
  id: number;
  name: string;
  profile_path: string | null;
  job?: string;
  department?: string;
};

export type TmdbPerson = {
  id: number;
  name: string;
  biography: string;
  profile_path: string | null;
  known_for_department?: string;
  birthday?: string | null;
  place_of_birth?: string | null;
};

export type TmdbPersonCredit = {
  id: number;
  media_type: 'movie' | 'tv';
  title?: string;
  name?: string;
  poster_path: string | null;
  backdrop_path: string | null;
  vote_average: number;
  release_date?: string;
  first_air_date?: string;
  character?: string;
  job?: string;
  department?: string;
};

export type TmdbWatchProvider = {
  provider_id: number;
  provider_name: string;
  logo_path: string | null;
  display_priority?: number;
};

export type TmdbWatchProviderRegion = {
  link?: string;
  flatrate?: TmdbWatchProvider[];
  rent?: TmdbWatchProvider[];
  buy?: TmdbWatchProvider[];
  ads?: TmdbWatchProvider[];
  free?: TmdbWatchProvider[];
};
