import {
  backendCreateCinemaEvent,
  backendGetCurrentCinemaEvent,
  backendGetLatestCinemaEvent,
  hasBackendApi,
} from '@/lib/cinema-backend';

export type CinemaEvent = {
  id: number;
  title: string;
  description: string | null;
  video_url: string;
  poster_url: string | null;
  tmdb_id?: number | null;
  start_at: string;
  end_at: string;
  created_by: number | null;
  created_at: string;
  updated_at: string;
};

export type CinemaEventInput = {
  title: string;
  description?: string | null;
  videoUrl: string;
  posterUrl?: string | null;
  tmdbId?: number | null;
  startAt: string;
  endAt: string;
  createdBy?: number | null;
};

type State = {
  items: CinemaEvent[];
  idSeq: number;
};

const STORAGE_KEY = 'movie_rec_cinema_events';

function loadState(): State {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { items: [], idSeq: 1 };
    const parsed = JSON.parse(raw) as State;
    return {
      items: parsed.items ?? [],
      idSeq: parsed.idSeq ?? ((parsed.items?.length ?? 0) + 1),
    };
  } catch {
    return { items: [], idSeq: 1 };
  }
}

function saveState(state: State) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
  }
}

const state = loadState();

function nowIso() {
  return new Date().toISOString();
}

export async function createCinemaEvent(input: CinemaEventInput, options?: { adminKey?: string | null }) {
  if (hasBackendApi()) {
    try {
      await backendCreateCinemaEvent(input, { adminKey: options?.adminKey ?? null });
      return;
    } catch {
      // Fallback to local storage if backend is down.
    }
  }

  const now = nowIso();
  const item: CinemaEvent = {
    id: state.idSeq++,
    title: input.title.trim(),
    description: input.description?.trim() || null,
    video_url: input.videoUrl.trim(),
    poster_url: input.posterUrl?.trim() || null,
    tmdb_id: Number.isFinite(Number(input.tmdbId)) ? Number(input.tmdbId) : null,
    start_at: input.startAt,
    end_at: input.endAt,
    created_by: input.createdBy ?? null,
    created_at: now,
    updated_at: now,
  };
  state.items.push(item);
  saveState(state);
}

export async function getLatestCinemaEvent(): Promise<CinemaEvent | null> {
  if (hasBackendApi()) {
    try {
      return await backendGetLatestCinemaEvent();
    } catch {
      // Fallback to local storage if backend is down.
    }
  }

  const sorted = [...state.items].sort((a, b) => Date.parse(b.start_at) - Date.parse(a.start_at));
  return sorted[0] ?? null;
}

export async function getCinemaEventByStatusNow(nowIsoValue = new Date().toISOString()): Promise<CinemaEvent | null> {
  if (hasBackendApi()) {
    try {
      return await backendGetCurrentCinemaEvent(nowIsoValue);
    } catch {
      // Fallback to local storage if backend is down.
    }
  }

  const now = Date.parse(nowIsoValue);
  const live = [...state.items]
    .filter((item) => Date.parse(item.start_at) <= now && Date.parse(item.end_at) >= now)
    .sort((a, b) => Date.parse(b.start_at) - Date.parse(a.start_at))[0];
  if (live) return live;

  const upcoming = [...state.items]
    .filter((item) => Date.parse(item.start_at) > now)
    .sort((a, b) => Date.parse(a.start_at) - Date.parse(b.start_at))[0];
  if (upcoming) return upcoming;

  return getLatestCinemaEvent();
}
