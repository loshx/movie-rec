import { getDb } from './database';
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

function nowIso() {
  return new Date().toISOString();
}

export async function createCinemaEvent(input: CinemaEventInput, options?: { adminKey?: string | null }) {
  if (hasBackendApi()) {
    await backendCreateCinemaEvent(input, { adminKey: options?.adminKey ?? null });
    return;
  }

  const db = await getDb();
  const now = nowIso();
  await db.runAsync(
    `
    INSERT INTO cinema_events
      (title, description, video_url, poster_url, tmdb_id, start_at, end_at, created_by, created_at, updated_at)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    input.title.trim(),
    input.description?.trim() || null,
    input.videoUrl.trim(),
    input.posterUrl?.trim() || null,
    Number.isFinite(Number(input.tmdbId)) ? Number(input.tmdbId) : null,
    input.startAt,
    input.endAt,
    input.createdBy ?? null,
    now,
    now
  );
}

export async function getLatestCinemaEvent(): Promise<CinemaEvent | null> {
  if (hasBackendApi()) {
    try {
      return await backendGetLatestCinemaEvent();
    } catch {
      return null;
    }
  }

  const db = await getDb();
  return db.getFirstAsync<CinemaEvent>(
    `
    SELECT *
    FROM cinema_events
    ORDER BY datetime(start_at) DESC
    LIMIT 1
    `
  );
}

export async function getCinemaEventByStatusNow(nowIsoValue = new Date().toISOString()): Promise<CinemaEvent | null> {
  if (hasBackendApi()) {
    try {
      return await backendGetCurrentCinemaEvent(nowIsoValue);
    } catch {
      return null;
    }
  }

  const db = await getDb();
  const live = await db.getFirstAsync<CinemaEvent>(
    `
    SELECT *
    FROM cinema_events
    WHERE datetime(start_at) <= datetime(?)
      AND datetime(end_at) >= datetime(?)
    ORDER BY datetime(start_at) DESC
    LIMIT 1
    `,
    nowIsoValue,
    nowIsoValue
  );
  if (live) return live;

  const upcoming = await db.getFirstAsync<CinemaEvent>(
    `
    SELECT *
    FROM cinema_events
    WHERE datetime(start_at) > datetime(?)
    ORDER BY datetime(start_at) ASC
    LIMIT 1
    `,
    nowIsoValue
  );
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
