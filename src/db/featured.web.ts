export type FeaturedMovie = {
  tmdb_id: number | null;
  title: string | null;
  overview: string | null;
  backdrop_path: string | null;
  poster_path: string | null;
  updated_at: string | null;
};

type FeaturedState = {
  featured: FeaturedMovie | null;
};

const STORAGE_KEY = 'movie_rec_featured_movie';

function loadState(): FeaturedState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { featured: null };
    const parsed = JSON.parse(raw) as FeaturedState;
    return { featured: parsed.featured ?? null };
  } catch {
    return { featured: null };
  }
}

function saveState(state: FeaturedState) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
  }
}

const state = loadState();

export async function getFeaturedMovie(): Promise<FeaturedMovie | null> {
  return state.featured;
}

export async function setFeaturedMovie(input: {
  tmdbId?: number | null;
  title?: string | null;
  overview?: string | null;
  backdropPath?: string | null;
  posterPath?: string | null;
}) {
  state.featured = {
    tmdb_id: input.tmdbId ?? null,
    title: input.title ?? null,
    overview: input.overview ?? null,
    backdrop_path: input.backdropPath ?? null,
    poster_path: input.posterPath ?? null,
    updated_at: new Date().toISOString(),
  };
  saveState(state);
}

export async function clearFeaturedMovie() {
  state.featured = null;
  saveState(state);
}
