import { getDb } from './database';
import { ingestMlInteraction } from '@/lib/ml-recommendations';
import { getBackendApiUrl, hasBackendApi } from '@/lib/cinema-backend';

function nowIso() {
  return new Date().toISOString();
}

export type MovieState = {
  inWatchlist: boolean;
  inFavorites: boolean;
  watched: boolean;
  rating: number | null;
};

export type MovieComment = {
  id: number;
  user_id: number;
  public_user_id?: number | null;
  avatar_url?: string | null;
  nickname: string;
  text: string;
  parent_id: number | null;
  created_at: string;
};

export type UserListItem = {
  tmdbId: number;
  createdAt: string;
  rating?: number;
  mediaType?: 'movie' | 'tv';
};

export type UserActorListItem = {
  personId: number;
  createdAt: string;
};

export type MovieEngagementCounts = {
  favorites: number;
  watched: number;
  rated: number;
};

export type UserListPrivacy = {
  watchlist: boolean;
  favorites: boolean;
  watched: boolean;
  rated: boolean;
};

const DEFAULT_PRIVACY: UserListPrivacy = {
  watchlist: false,
  favorites: false,
  watched: false,
  rated: false,
};

type RemoteMovieListEntry = {
  tmdb_id: number;
  media_type?: 'movie' | 'tv' | string;
  created_at?: string;
};

type RemoteMovieRatingEntry = RemoteMovieListEntry & {
  rating: number;
  updated_at?: string;
};

type RemotePersonFavoriteEntry = {
  person_id?: number;
  personId?: number;
  created_at?: string;
  createdAt?: string;
};

type RemoteMovieStatePayload = {
  state?: {
    privacy?: UserListPrivacy;
    watchlist?: RemoteMovieListEntry[];
    favorites?: RemoteMovieListEntry[];
    watched?: RemoteMovieListEntry[];
    ratings?: RemoteMovieRatingEntry[];
  };
  item_state?: {
    in_watchlist?: boolean;
    in_favorites?: boolean;
    watched?: boolean;
    rating?: number | null;
  };
};

function normalizeMediaType(value: unknown): 'movie' | 'tv' {
  return String(value ?? '').toLowerCase() === 'tv' ? 'tv' : 'movie';
}

function normalizePrivacy(value: Partial<UserListPrivacy> | undefined | null): UserListPrivacy {
  return {
    watchlist: !!value?.watchlist,
    favorites: !!value?.favorites,
    watched: !!value?.watched,
    rated: !!value?.rated,
  };
}

function mapRemoteList(rows: RemoteMovieListEntry[] | undefined): UserListItem[] {
  return (rows ?? []).map((row) => ({
    tmdbId: Number(row.tmdb_id),
    createdAt: String(row.created_at ?? nowIso()),
    mediaType: normalizeMediaType(row.media_type),
  }));
}

function mapRemoteRatings(rows: RemoteMovieRatingEntry[] | undefined): UserListItem[] {
  return (rows ?? []).map((row) => ({
    tmdbId: Number(row.tmdb_id),
    rating: Number(row.rating),
    createdAt: String(row.updated_at ?? row.created_at ?? nowIso()),
    mediaType: normalizeMediaType(row.media_type),
  }));
}

function mapRemotePersonFavorites(rows: RemotePersonFavoriteEntry[] | undefined): UserActorListItem[] {
  const entries = Array.isArray(rows) ? rows : [];
  const unique = new Map<number, UserActorListItem>();
  for (const row of entries) {
    const personId = Number(row?.person_id ?? row?.personId);
    if (!Number.isFinite(personId) || personId <= 0) continue;
    unique.set(personId, {
      personId,
      createdAt: String(row?.created_at ?? row?.createdAt ?? nowIso()),
    });
  }
  return Array.from(unique.values());
}

async function requestBackendJson<T>(path: string, init?: RequestInit): Promise<T | null> {
  if (!hasBackendApi()) return null;
  const url = getBackendApiUrl(path);
  if (!url) return null;
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(init?.headers as Record<string, string> | undefined),
    };
    const res = await fetch(url, { ...init, headers });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export async function getUserListPrivacy(userId: number): Promise<UserListPrivacy> {
  const remote = await requestBackendJson<RemoteMovieStatePayload>(`/api/users/${userId}/movie-state`);
  if (remote?.state?.privacy) {
    return normalizePrivacy(remote.state.privacy);
  }

  const db = await getDb();
  const row = await db.getFirstAsync<{
    watchlist: number;
    favorites: number;
    watched: number;
    rated: number;
  }>(
    'SELECT watchlist, favorites, watched, rated FROM user_list_privacy WHERE user_id = ?',
    userId
  );
  if (!row) return { ...DEFAULT_PRIVACY };
  return {
    watchlist: !!row.watchlist,
    favorites: !!row.favorites,
    watched: !!row.watched,
    rated: !!row.rated,
  };
}

export async function setUserListPrivacy(userId: number, privacy: UserListPrivacy) {
  const remote = await requestBackendJson<{ privacy?: UserListPrivacy }>(
    `/api/users/${userId}/movie-state/privacy`,
    {
      method: 'POST',
      body: JSON.stringify({ privacy }),
    }
  );
  if (remote?.privacy) return;

  const db = await getDb();
  const now = nowIso();
  await db.runAsync(
    `
    INSERT INTO user_list_privacy (user_id, watchlist, favorites, watched, rated, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id)
    DO UPDATE SET
      watchlist = excluded.watchlist,
      favorites = excluded.favorites,
      watched = excluded.watched,
      rated = excluded.rated,
      updated_at = excluded.updated_at
    `,
    userId,
    privacy.watchlist ? 1 : 0,
    privacy.favorites ? 1 : 0,
    privacy.watched ? 1 : 0,
    privacy.rated ? 1 : 0,
    now
  );
}

export async function getMovieState(userId: number, tmdbId: number): Promise<MovieState> {
  const remote = await requestBackendJson<RemoteMovieStatePayload>(
    `/api/users/${userId}/movie-state?tmdb_id=${encodeURIComponent(String(tmdbId))}`
  );
  if (remote?.item_state) {
    return {
      inWatchlist: !!remote.item_state.in_watchlist,
      inFavorites: !!remote.item_state.in_favorites,
      watched: !!remote.item_state.watched,
      rating:
        typeof remote.item_state.rating === 'number' && Number.isFinite(remote.item_state.rating)
          ? remote.item_state.rating
          : null,
    };
  }

  const db = await getDb();
  const watch = await db.getFirstAsync<{ ok: number }>(
    'SELECT 1 as ok FROM user_watchlist WHERE user_id = ? AND tmdb_id = ?',
    userId,
    tmdbId
  );
  const fav = await db.getFirstAsync<{ ok: number }>(
    'SELECT 1 as ok FROM user_favorites WHERE user_id = ? AND tmdb_id = ?',
    userId,
    tmdbId
  );
  const ratingRow = await db.getFirstAsync<{ rating: number }>(
    'SELECT rating FROM user_ratings WHERE user_id = ? AND tmdb_id = ?',
    userId,
    tmdbId
  );
  const watched = await db.getFirstAsync<{ ok: number }>(
    'SELECT 1 as ok FROM user_watched WHERE user_id = ? AND tmdb_id = ?',
    userId,
    tmdbId
  );

  return {
    inWatchlist: !!watch,
    inFavorites: !!fav,
    watched: !!watched,
    rating: ratingRow?.rating ?? null,
  };
}

export async function getUserWatchlist(userId: number): Promise<UserListItem[]> {
  const remote = await requestBackendJson<RemoteMovieStatePayload>(`/api/users/${userId}/movie-state`);
  if (remote?.state?.watchlist) {
    return mapRemoteList(remote.state.watchlist);
  }

  const db = await getDb();
  const rows = await db.getAllAsync<{ tmdb_id: number; created_at: string; media_type?: string }>(
    `SELECT tmdb_id, created_at, media_type FROM user_watchlist WHERE user_id = ? ORDER BY created_at DESC`,
    userId
  );
  return rows.map((row) => ({
    tmdbId: row.tmdb_id,
    createdAt: row.created_at,
    mediaType: row.media_type === 'tv' ? 'tv' : 'movie',
  }));
}

export async function getUserFavorites(userId: number): Promise<UserListItem[]> {
  const remote = await requestBackendJson<RemoteMovieStatePayload>(`/api/users/${userId}/movie-state`);
  if (remote?.state?.favorites) {
    return mapRemoteList(remote.state.favorites);
  }

  const db = await getDb();
  const rows = await db.getAllAsync<{ tmdb_id: number; created_at: string; media_type?: string }>(
    `SELECT tmdb_id, created_at, media_type FROM user_favorites WHERE user_id = ? ORDER BY created_at DESC`,
    userId
  );
  return rows.map((row) => ({
    tmdbId: row.tmdb_id,
    createdAt: row.created_at,
    mediaType: row.media_type === 'tv' ? 'tv' : 'movie',
  }));
}

export async function getUserRatings(userId: number): Promise<UserListItem[]> {
  const remote = await requestBackendJson<RemoteMovieStatePayload>(`/api/users/${userId}/movie-state`);
  if (remote?.state?.ratings) {
    return mapRemoteRatings(remote.state.ratings);
  }

  const db = await getDb();
  const rows = await db.getAllAsync<{ tmdb_id: number; rating: number; updated_at: string; media_type?: string }>(
    `SELECT tmdb_id, rating, updated_at, media_type FROM user_ratings WHERE user_id = ? ORDER BY updated_at DESC`,
    userId
  );
  return rows.map((row) => ({
    tmdbId: row.tmdb_id,
    rating: row.rating,
    createdAt: row.updated_at,
    mediaType: row.media_type === 'tv' ? 'tv' : 'movie',
  }));
}

export async function getUserWatched(userId: number): Promise<UserListItem[]> {
  const remote = await requestBackendJson<RemoteMovieStatePayload>(`/api/users/${userId}/movie-state`);
  if (remote?.state?.watched) {
    return mapRemoteList(remote.state.watched);
  }

  const db = await getDb();
  const rows = await db.getAllAsync<{ tmdb_id: number; created_at: string; media_type?: string }>(
    `SELECT tmdb_id, created_at, media_type FROM user_watched WHERE user_id = ? ORDER BY created_at DESC`,
    userId
  );
  return rows.map((row) => ({
    tmdbId: row.tmdb_id,
    createdAt: row.created_at,
    mediaType: row.media_type === 'tv' ? 'tv' : 'movie',
  }));
}

export async function getMovieEngagementCounts(
  tmdbId: number,
  mediaType: 'movie' | 'tv' = 'movie'
): Promise<MovieEngagementCounts> {
  const remote = await requestBackendJson<{ counts?: MovieEngagementCounts }>(
    `/api/movies/${encodeURIComponent(String(tmdbId))}/engagement?media_type=${encodeURIComponent(mediaType)}`
  );
  if (remote?.counts) {
    return {
      favorites: Number(remote.counts.favorites ?? 0),
      watched: Number(remote.counts.watched ?? 0),
      rated: Number(remote.counts.rated ?? 0),
    };
  }

  const db = await getDb();
  const [favoritesRow, watchedRow, ratedRow] = await Promise.all([
    db.getFirstAsync<{ c: number }>(
      'SELECT COUNT(*) as c FROM user_favorites WHERE tmdb_id = ? AND media_type = ?',
      tmdbId,
      mediaType
    ),
    db.getFirstAsync<{ c: number }>(
      'SELECT COUNT(*) as c FROM user_watched WHERE tmdb_id = ? AND media_type = ?',
      tmdbId,
      mediaType
    ),
    db.getFirstAsync<{ c: number }>(
      'SELECT COUNT(*) as c FROM user_ratings WHERE tmdb_id = ? AND media_type = ?',
      tmdbId,
      mediaType
    ),
  ]);

  return {
    favorites: Number(favoritesRow?.c ?? 0),
    watched: Number(watchedRow?.c ?? 0),
    rated: Number(ratedRow?.c ?? 0),
  };
}

export async function getUserFavoriteActors(userId: number): Promise<UserActorListItem[]> {
  const remote = await requestBackendJson<{ items?: RemotePersonFavoriteEntry[] }>(`/api/users/${userId}/favorite-actors`);
  if (Array.isArray(remote?.items)) {
    return mapRemotePersonFavorites(remote.items);
  }

  const db = await getDb();
  const rows = await db.getAllAsync<{ person_id: number; created_at: string }>(
    `SELECT person_id, created_at FROM user_favorite_actors WHERE user_id = ? ORDER BY created_at DESC`,
    userId
  );
  return rows.map((row) => ({
    personId: row.person_id,
    createdAt: row.created_at,
  }));
}

export async function getUserFavoriteDirectors(userId: number): Promise<UserActorListItem[]> {
  const remote = await requestBackendJson<{ items?: RemotePersonFavoriteEntry[] }>(
    `/api/users/${userId}/favorite-directors`
  );
  if (Array.isArray(remote?.items)) {
    return mapRemotePersonFavorites(remote.items);
  }

  const db = await getDb();
  const rows = await db.getAllAsync<{ person_id: number; created_at: string }>(
    `SELECT person_id, created_at FROM user_favorite_directors WHERE user_id = ? ORDER BY created_at DESC`,
    userId
  );
  return rows.map((row) => ({
    personId: row.person_id,
    createdAt: row.created_at,
  }));
}

export async function isFavoriteActor(userId: number, personId: number): Promise<boolean> {
  const remote = await requestBackendJson<{ items?: RemotePersonFavoriteEntry[] }>(`/api/users/${userId}/favorite-actors`);
  if (Array.isArray(remote?.items)) {
    return mapRemotePersonFavorites(remote.items).some((entry) => entry.personId === personId);
  }

  const db = await getDb();
  const row = await db.getFirstAsync<{ ok: number }>(
    `SELECT 1 as ok FROM user_favorite_actors WHERE user_id = ? AND person_id = ?`,
    userId,
    personId
  );
  return !!row;
}

export async function toggleFavoriteActor(userId: number, personId: number) {
  const remote = await requestBackendJson<{ active?: boolean }>(`/api/users/${userId}/favorite-actors/toggle`, {
    method: 'POST',
    body: JSON.stringify({ person_id: personId }),
  });
  if (typeof remote?.active === 'boolean') {
    return remote.active;
  }

  const db = await getDb();
  const existing = await db.getFirstAsync<{ ok: number }>(
    'SELECT 1 as ok FROM user_favorite_actors WHERE user_id = ? AND person_id = ?',
    userId,
    personId
  );
  if (existing) {
    await db.runAsync('DELETE FROM user_favorite_actors WHERE user_id = ? AND person_id = ?', userId, personId);
    return false;
  }
  await db.runAsync(
    'INSERT OR IGNORE INTO user_favorite_actors (user_id, person_id, created_at) VALUES (?, ?, ?)',
    userId,
    personId,
    nowIso()
  );
  return true;
}

export async function isFavoriteDirector(userId: number, personId: number): Promise<boolean> {
  const remote = await requestBackendJson<{ items?: RemotePersonFavoriteEntry[] }>(
    `/api/users/${userId}/favorite-directors`
  );
  if (Array.isArray(remote?.items)) {
    return mapRemotePersonFavorites(remote.items).some((entry) => entry.personId === personId);
  }

  const db = await getDb();
  const row = await db.getFirstAsync<{ ok: number }>(
    `SELECT 1 as ok FROM user_favorite_directors WHERE user_id = ? AND person_id = ?`,
    userId,
    personId
  );
  return !!row;
}

export async function toggleFavoriteDirector(userId: number, personId: number) {
  const remote = await requestBackendJson<{ active?: boolean }>(`/api/users/${userId}/favorite-directors/toggle`, {
    method: 'POST',
    body: JSON.stringify({ person_id: personId }),
  });
  if (typeof remote?.active === 'boolean') {
    return remote.active;
  }

  const db = await getDb();
  const existing = await db.getFirstAsync<{ ok: number }>(
    'SELECT 1 as ok FROM user_favorite_directors WHERE user_id = ? AND person_id = ?',
    userId,
    personId
  );
  if (existing) {
    await db.runAsync('DELETE FROM user_favorite_directors WHERE user_id = ? AND person_id = ?', userId, personId);
    return false;
  }
  await db.runAsync(
    'INSERT OR IGNORE INTO user_favorite_directors (user_id, person_id, created_at) VALUES (?, ?, ?)',
    userId,
    personId,
    nowIso()
  );
  return true;
}

export async function toggleWatchlist(userId: number, tmdbId: number, mediaType: 'movie' | 'tv' = 'movie') {
  const remote = await requestBackendJson<{ active?: boolean }>(`/api/users/${userId}/movie-state/toggle`, {
    method: 'POST',
    body: JSON.stringify({
      list: 'watchlist',
      tmdb_id: tmdbId,
      media_type: mediaType,
    }),
  });
  if (typeof remote?.active === 'boolean') {
    if (remote.active) {
      void ingestMlInteraction({
        user_id: userId,
        tmdb_id: tmdbId,
        media_type: mediaType,
        event_type: 'watchlist',
        event_value: 1,
        occurred_at: nowIso(),
      }).catch(() => {});
    }
    return remote.active;
  }

  const db = await getDb();
  const existing = await db.getFirstAsync<{ ok: number }>(
    'SELECT 1 as ok FROM user_watchlist WHERE user_id = ? AND tmdb_id = ?',
    userId,
    tmdbId
  );
  if (existing) {
    await db.runAsync('DELETE FROM user_watchlist WHERE user_id = ? AND tmdb_id = ?', userId, tmdbId);
    return false;
  }
  await db.runAsync(
    'INSERT OR IGNORE INTO user_watchlist (user_id, tmdb_id, media_type, created_at) VALUES (?, ?, ?, ?)',
    userId,
    tmdbId,
    mediaType,
    nowIso()
  );
  void ingestMlInteraction({
    user_id: userId,
    tmdb_id: tmdbId,
    media_type: mediaType,
    event_type: 'watchlist',
    event_value: 1,
    occurred_at: nowIso(),
  }).catch(() => {});
  return true;
}

export async function toggleFavorite(userId: number, tmdbId: number, mediaType: 'movie' | 'tv' = 'movie') {
  const remote = await requestBackendJson<{ active?: boolean }>(`/api/users/${userId}/movie-state/toggle`, {
    method: 'POST',
    body: JSON.stringify({
      list: 'favorites',
      tmdb_id: tmdbId,
      media_type: mediaType,
    }),
  });
  if (typeof remote?.active === 'boolean') {
    if (remote.active) {
      void ingestMlInteraction({
        user_id: userId,
        tmdb_id: tmdbId,
        media_type: mediaType,
        event_type: 'favorite',
        event_value: 1,
        occurred_at: nowIso(),
      }).catch(() => {});
    }
    return remote.active;
  }

  const db = await getDb();
  const existing = await db.getFirstAsync<{ ok: number }>(
    'SELECT 1 as ok FROM user_favorites WHERE user_id = ? AND tmdb_id = ?',
    userId,
    tmdbId
  );
  if (existing) {
    await db.runAsync('DELETE FROM user_favorites WHERE user_id = ? AND tmdb_id = ?', userId, tmdbId);
    return false;
  }
  await db.runAsync(
    'INSERT OR IGNORE INTO user_favorites (user_id, tmdb_id, media_type, created_at) VALUES (?, ?, ?, ?)',
    userId,
    tmdbId,
    mediaType,
    nowIso()
  );
  void ingestMlInteraction({
    user_id: userId,
    tmdb_id: tmdbId,
    media_type: mediaType,
    event_type: 'favorite',
    event_value: 1,
    occurred_at: nowIso(),
  }).catch(() => {});
  return true;
}

export async function toggleWatched(userId: number, tmdbId: number, mediaType: 'movie' | 'tv' = 'movie') {
  const remote = await requestBackendJson<{ active?: boolean }>(`/api/users/${userId}/movie-state/toggle`, {
    method: 'POST',
    body: JSON.stringify({
      list: 'watched',
      tmdb_id: tmdbId,
      media_type: mediaType,
    }),
  });
  if (typeof remote?.active === 'boolean') {
    if (remote.active) {
      void ingestMlInteraction({
        user_id: userId,
        tmdb_id: tmdbId,
        media_type: mediaType,
        event_type: 'watched',
        event_value: 1,
        occurred_at: nowIso(),
      }).catch(() => {});
    }
    return remote.active;
  }

  const db = await getDb();
  const existing = await db.getFirstAsync<{ ok: number }>(
    'SELECT 1 as ok FROM user_watched WHERE user_id = ? AND tmdb_id = ?',
    userId,
    tmdbId
  );
  if (existing) {
    await db.runAsync('DELETE FROM user_watched WHERE user_id = ? AND tmdb_id = ?', userId, tmdbId);
    return false;
  }
  await db.runAsync(
    'INSERT OR IGNORE INTO user_watched (user_id, tmdb_id, media_type, created_at) VALUES (?, ?, ?, ?)',
    userId,
    tmdbId,
    mediaType,
    nowIso()
  );
  void ingestMlInteraction({
    user_id: userId,
    tmdb_id: tmdbId,
    media_type: mediaType,
    event_type: 'watched',
    event_value: 1,
    occurred_at: nowIso(),
  }).catch(() => {});
  return true;
}

export async function setWatched(
  userId: number,
  tmdbId: number,
  watched: boolean,
  mediaType: 'movie' | 'tv' = 'movie'
) {
  const remote = await requestBackendJson<{ watched?: boolean }>(`/api/users/${userId}/movie-state/watched`, {
    method: 'POST',
    body: JSON.stringify({
      tmdb_id: tmdbId,
      watched,
      media_type: mediaType,
    }),
  });
  if (typeof remote?.watched === 'boolean') {
    if (remote.watched) {
      void ingestMlInteraction({
        user_id: userId,
        tmdb_id: tmdbId,
        media_type: mediaType,
        event_type: 'watched',
        event_value: 1,
        occurred_at: nowIso(),
      }).catch(() => {});
    }
    return remote.watched;
  }

  const db = await getDb();
  if (!watched) {
    await db.runAsync('DELETE FROM user_watched WHERE user_id = ? AND tmdb_id = ?', userId, tmdbId);
    return false;
  }
  await db.runAsync(
    'INSERT OR IGNORE INTO user_watched (user_id, tmdb_id, media_type, created_at) VALUES (?, ?, ?, ?)',
    userId,
    tmdbId,
    mediaType,
    nowIso()
  );
  void ingestMlInteraction({
    user_id: userId,
    tmdb_id: tmdbId,
    media_type: mediaType,
    event_type: 'watched',
    event_value: 1,
    occurred_at: nowIso(),
  }).catch(() => {});
  return true;
}

export async function setRating(
  userId: number,
  tmdbId: number,
  rating: number,
  mediaType: 'movie' | 'tv' = 'movie'
) {
  const remote = await requestBackendJson<{ ok?: boolean }>(`/api/users/${userId}/movie-state/rating`, {
    method: 'POST',
    body: JSON.stringify({
      tmdb_id: tmdbId,
      rating,
      media_type: mediaType,
    }),
  });
  if (remote?.ok) {
    void ingestMlInteraction({
      user_id: userId,
      tmdb_id: tmdbId,
      media_type: mediaType,
      event_type: 'rating',
      event_value: rating,
      occurred_at: nowIso(),
    }).catch(() => {});
    return;
  }

  const db = await getDb();
  const now = nowIso();
  await db.runAsync(
    `
    INSERT INTO user_ratings (user_id, tmdb_id, media_type, rating, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, tmdb_id)
    DO UPDATE SET media_type = excluded.media_type, rating = excluded.rating, updated_at = excluded.updated_at
    `,
    userId,
    tmdbId,
    mediaType,
    rating,
    now,
    now
  );
  void ingestMlInteraction({
    user_id: userId,
    tmdb_id: tmdbId,
    media_type: mediaType,
    event_type: 'rating',
    event_value: rating,
    occurred_at: now,
  }).catch(() => {});
}

export async function addComment(
  userId: number,
  tmdbId: number,
  text: string,
  parentId?: number | null,
  nickname?: string,
  avatarUrl?: string | null
) {
  if (hasBackendApi()) {
    const url = getBackendApiUrl('/api/comments');
    if (url) {
      try {
        await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            user_id: userId,
            tmdb_id: tmdbId,
            text,
            parent_id: parentId ?? null,
            nickname: nickname ?? 'user',
            avatar_url: avatarUrl ?? null,
          }),
        });
        return;
      } catch {
      }
    }
  }

  const db = await getDb();
  const clean = text.trim();
  if (!clean) return;
  await db.runAsync(
    `INSERT INTO user_comments (user_id, tmdb_id, text, parent_id, created_at) VALUES (?, ?, ?, ?, ?)`,
    userId,
    tmdbId,
    clean,
    parentId ?? null,
    nowIso()
  );
}

export async function getComments(tmdbId: number): Promise<MovieComment[]> {
  if (hasBackendApi()) {
    const url = getBackendApiUrl(`/api/comments?tmdb_id=${encodeURIComponent(String(tmdbId))}`);
    if (url) {
      try {
        const res = await fetch(url);
        if (res.ok) {
          const payload = (await res.json()) as { comments?: MovieComment[] };
          return payload.comments ?? [];
        }
      } catch {
      }
    }
  }

  const db = await getDb();
  return db.getAllAsync<MovieComment>(
    `
    SELECT c.id, c.user_id, u.nickname, u.avatar_url, c.text, c.parent_id, c.created_at
    FROM user_comments c
    JOIN users u ON u.id = c.user_id
    WHERE c.tmdb_id = ?
    ORDER BY c.created_at ASC
    `,
    tmdbId
  );
}

export async function syncCommentAvatarsForUser(_userId: number, _avatarUrl: string | null) {
  // Native/local comments read avatar directly from users table via JOIN.
}
