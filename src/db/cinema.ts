import { getDb } from './database';
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

function nowIso() {
  return new Date().toISOString();
}

export async function createCinemaEvent(input: CinemaEventInput, options?: { adminKey?: string | null }) {
  if (hasBackendApi()) {
    try {
      await backendCreateCinemaEvent(input, { adminKey: options?.adminKey ?? null });
      return;
    } catch {
      // Fallback to local DB if backend is down.
    }
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
      // Fallback to local DB if backend is down.
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
      // Fallback to local DB if backend is down.
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
