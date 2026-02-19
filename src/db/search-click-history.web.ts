export type SearchClickItem = {
  tmdbId: number;
  mediaType: 'movie' | 'tv';
  title: string;
  posterPath: string | null;
  voteAverage: number;
  lastUsedAt: string;
};

type SearchClickState = {
  byUser: Record<string, SearchClickItem[]>;
};

const STORAGE_KEY = 'movie_rec_search_click_history';

function loadState(): SearchClickState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { byUser: {} };
    const parsed = JSON.parse(raw) as SearchClickState;
    return { byUser: parsed.byUser ?? {} };
  } catch {
    return { byUser: {} };
  }
}

function saveState(state: SearchClickState) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
  }
}

const state = loadState();

function nowIso() {
  return new Date().toISOString();
}

export async function getSearchClickHistory(userId: number, limit = 12): Promise<SearchClickItem[]> {
  const key = String(userId);
  return (state.byUser[key] ?? []).slice(0, limit);
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
  const key = String(userId);
  const prev = state.byUser[key] ?? [];
  const nextItem: SearchClickItem = {
    tmdbId: item.tmdbId,
    mediaType: item.mediaType,
    title: item.title,
    posterPath: item.posterPath ?? null,
    voteAverage: item.voteAverage ?? 0,
    lastUsedAt: nowIso(),
  };
  const next = [nextItem, ...prev.filter((x) => !(x.tmdbId === nextItem.tmdbId && x.mediaType === nextItem.mediaType))].slice(0, 30);
  state.byUser[key] = next;
  saveState(state);
}
