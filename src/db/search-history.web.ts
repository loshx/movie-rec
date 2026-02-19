type SearchHistoryState = {
  byUser: Record<string, string[]>;
};

const STORAGE_KEY = 'movie_rec_search_history';

function loadState(): SearchHistoryState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { byUser: {} };
    const parsed = JSON.parse(raw) as SearchHistoryState;
    return { byUser: parsed.byUser ?? {} };
  } catch {
    return { byUser: {} };
  }
}

function saveState(state: SearchHistoryState) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
  }
}

const state = loadState();

export async function getSearchHistory(userId: number, limit = 8): Promise<string[]> {
  const key = String(userId);
  return (state.byUser[key] ?? []).slice(0, limit);
}

export async function upsertSearchHistory(userId: number, query: string) {
  const clean = query.trim();
  if (!clean) return;
  const key = String(userId);
  const prev = state.byUser[key] ?? [];
  const next = [clean, ...prev.filter((item) => item !== clean)].slice(0, 20);
  state.byUser[key] = next;
  saveState(state);
}
