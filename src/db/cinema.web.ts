import {
  backendCloseCinemaPoll,
  backendCreateCinemaEvent,
  backendCreateCinemaPoll,
  backendGetCurrentCinemaPoll,
  backendGetCurrentCinemaEvent,
  backendGetLatestCinemaEvent,
  backendVoteCinemaPoll,
  hasBackendApi,
  type BackendCinemaPoll,
  type BackendCinemaPollOption,
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

export type CinemaPollOption = BackendCinemaPollOption;
export type CinemaPoll = BackendCinemaPoll;

export type CinemaPollInput = {
  question?: string | null;
  options: Array<{
    id?: string;
    title: string;
    poster_url: string;
    tmdb_id?: number | null;
  }>;
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
    await backendCreateCinemaEvent(input, { adminKey: options?.adminKey ?? null });
    return;
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
      return null;
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
      return null;
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

export async function getCurrentCinemaPoll(userId?: number | null): Promise<CinemaPoll | null> {
  if (hasBackendApi()) {
    try {
      return await backendGetCurrentCinemaPoll(userId ?? null);
    } catch {
      return null;
    }
  }
  return null;
}

export async function createCinemaPoll(input: CinemaPollInput, options?: { adminKey?: string | null }) {
  if (!hasBackendApi()) {
    throw new Error('Cinema poll requires backend.');
  }
  const poll = await backendCreateCinemaPoll(input, { adminKey: options?.adminKey ?? null });
  if (!poll) throw new Error('Could not create cinema poll.');
  return poll;
}

export async function voteCinemaPoll(pollId: number, userId: number, optionId: string) {
  if (!hasBackendApi()) {
    throw new Error('Cinema poll requires backend.');
  }
  const poll = await backendVoteCinemaPoll(pollId, userId, optionId);
  if (!poll) throw new Error('Could not submit vote.');
  return poll;
}

export async function closeCinemaPoll(pollId: number, options?: { adminKey?: string | null }) {
  if (!hasBackendApi()) {
    throw new Error('Cinema poll requires backend.');
  }
  const poll = await backendCloseCinemaPoll(pollId, { adminKey: options?.adminKey ?? null });
  if (!poll) throw new Error('Could not close cinema poll.');
  return poll;
}
