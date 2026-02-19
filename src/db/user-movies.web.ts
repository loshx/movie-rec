import { ingestMlInteraction } from '@/lib/ml-recommendations';
import { getBackendApiUrl, hasBackendApi } from '@/lib/cinema-backend';

type WebMovieState = {
  watchlist: Record<string, boolean>;
  favorites: Record<string, boolean>;
  favoriteActors: Record<string, boolean>;
  favoriteDirectors: Record<string, boolean>;
  watched: Record<string, boolean>;
  privacy: Record<string, UserListPrivacy>;
  watchlistMediaType: Record<string, 'movie' | 'tv'>;
  favoritesMediaType: Record<string, 'movie' | 'tv'>;
  watchedMediaType: Record<string, 'movie' | 'tv'>;
  ratingsMediaType: Record<string, 'movie' | 'tv'>;
  ratings: Record<string, number>;
  comments: WebComment[];
};

type WebComment = {
  id: number;
  user_id: number;
  avatar_url?: string | null;
  nickname: string;
  tmdb_id: number;
  text: string;
  parent_id: number | null;
  created_at: string;
};

const STORAGE_KEY = 'movie_rec_user_movies';

function loadState(): WebMovieState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return {
        watchlist: {},
        favorites: {},
        favoriteActors: {},
        favoriteDirectors: {},
        watched: {},
        privacy: {},
        watchlistMediaType: {},
        favoritesMediaType: {},
        watchedMediaType: {},
        ratingsMediaType: {},
        ratings: {},
        comments: [],
      };
    }
    const parsed = JSON.parse(raw) as WebMovieState;
    return {
      watchlist: parsed.watchlist ?? {},
      favorites: parsed.favorites ?? {},
      favoriteActors: parsed.favoriteActors ?? {},
      favoriteDirectors: parsed.favoriteDirectors ?? {},
      watched: parsed.watched ?? {},
      privacy: parsed.privacy ?? {},
      watchlistMediaType: parsed.watchlistMediaType ?? {},
      favoritesMediaType: parsed.favoritesMediaType ?? {},
      watchedMediaType: parsed.watchedMediaType ?? {},
      ratingsMediaType: parsed.ratingsMediaType ?? {},
      ratings: parsed.ratings ?? {},
      comments: parsed.comments ?? [],
    };
  } catch {
    return {
      watchlist: {},
      favorites: {},
      favoriteActors: {},
      favoriteDirectors: {},
      watched: {},
      privacy: {},
      watchlistMediaType: {},
      favoritesMediaType: {},
      watchedMediaType: {},
      ratingsMediaType: {},
      ratings: {},
      comments: [],
    };
  }
}

function saveState(state: WebMovieState) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
  }
}

const state = loadState();

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

function parseCompositeKey(key: string) {
  const [user, tmdb] = key.split(':');
  const userId = Number(user);
  const tmdbId = Number(tmdb);
  if (!Number.isFinite(userId) || !Number.isFinite(tmdbId)) return null;
  return { userId, tmdbId };
}

export async function getMovieState(userId: number, tmdbId: number): Promise<MovieState> {
  const key = `${userId}:${tmdbId}`;
  const watch = !!state.watchlist[key];
  const fav = !!state.favorites[key];
  const watched = !!state.watched[key];
  const rating = state.ratings[key] ?? null;
  return { inWatchlist: watch, inFavorites: fav, watched, rating };
}

export async function getUserListPrivacy(userId: number): Promise<UserListPrivacy> {
  return state.privacy[String(userId)] ?? { ...DEFAULT_PRIVACY };
}

export async function setUserListPrivacy(userId: number, privacy: UserListPrivacy) {
  state.privacy[String(userId)] = { ...privacy };
  saveState(state);
}

export async function getUserWatchlist(userId: number): Promise<UserListItem[]> {
  return Object.entries(state.watchlist)
    .filter(([, inList]) => !!inList)
    .map(([key]) => parseCompositeKey(key))
    .filter((entry): entry is { userId: number; tmdbId: number } => !!entry && entry.userId === userId)
    .map((entry) => ({
      tmdbId: entry.tmdbId,
      createdAt: nowIso(),
      mediaType: state.watchlistMediaType[`${entry.userId}:${entry.tmdbId}`] ?? 'movie',
    }));
}

export async function getUserFavorites(userId: number): Promise<UserListItem[]> {
  return Object.entries(state.favorites)
    .filter(([, inList]) => !!inList)
    .map(([key]) => parseCompositeKey(key))
    .filter((entry): entry is { userId: number; tmdbId: number } => !!entry && entry.userId === userId)
    .map((entry) => ({
      tmdbId: entry.tmdbId,
      createdAt: nowIso(),
      mediaType: state.favoritesMediaType[`${entry.userId}:${entry.tmdbId}`] ?? 'movie',
    }));
}

export async function getUserRatings(userId: number): Promise<UserListItem[]> {
  const items: UserListItem[] = [];
  for (const [key, rating] of Object.entries(state.ratings)) {
    const parsed = parseCompositeKey(key);
    if (!parsed || parsed.userId !== userId) continue;
    items.push({
      tmdbId: parsed.tmdbId,
      rating,
      createdAt: nowIso(),
      mediaType: state.ratingsMediaType[key] ?? 'movie',
    });
  }
  return items;
}

export async function getUserWatched(userId: number): Promise<UserListItem[]> {
  return Object.entries(state.watched)
    .filter(([, inList]) => !!inList)
    .map(([key]) => parseCompositeKey(key))
    .filter((entry): entry is { userId: number; tmdbId: number } => !!entry && entry.userId === userId)
    .map((entry) => ({
      tmdbId: entry.tmdbId,
      createdAt: nowIso(),
      mediaType: state.watchedMediaType[`${entry.userId}:${entry.tmdbId}`] ?? 'movie',
    }));
}

export async function getUserFavoriteActors(userId: number): Promise<UserActorListItem[]> {
  return Object.entries(state.favoriteActors)
    .filter(([, inList]) => !!inList)
    .map(([key]) => parseCompositeKey(key))
    .filter((entry): entry is { userId: number; tmdbId: number } => !!entry && entry.userId === userId)
    .map((entry) => ({
      personId: entry.tmdbId,
      createdAt: nowIso(),
    }));
}

export async function getUserFavoriteDirectors(userId: number): Promise<UserActorListItem[]> {
  return Object.entries(state.favoriteDirectors)
    .filter(([, inList]) => !!inList)
    .map(([key]) => parseCompositeKey(key))
    .filter((entry): entry is { userId: number; tmdbId: number } => !!entry && entry.userId === userId)
    .map((entry) => ({
      personId: entry.tmdbId,
      createdAt: nowIso(),
    }));
}

export async function isFavoriteActor(userId: number, personId: number): Promise<boolean> {
  const key = `${userId}:${personId}`;
  return !!state.favoriteActors[key];
}

export async function toggleFavoriteActor(userId: number, personId: number) {
  const key = `${userId}:${personId}`;
  state.favoriteActors[key] = !state.favoriteActors[key];
  saveState(state);
  return state.favoriteActors[key];
}

export async function isFavoriteDirector(userId: number, personId: number): Promise<boolean> {
  const key = `${userId}:${personId}`;
  return !!state.favoriteDirectors[key];
}

export async function toggleFavoriteDirector(userId: number, personId: number) {
  const key = `${userId}:${personId}`;
  state.favoriteDirectors[key] = !state.favoriteDirectors[key];
  saveState(state);
  return state.favoriteDirectors[key];
}

export async function toggleWatchlist(userId: number, tmdbId: number, mediaType: 'movie' | 'tv' = 'movie') {
  const key = `${userId}:${tmdbId}`;
  state.watchlist[key] = !state.watchlist[key];
  if (state.watchlist[key]) state.watchlistMediaType[key] = mediaType;
  else delete state.watchlistMediaType[key];
  saveState(state);
  if (state.watchlist[key]) {
    void ingestMlInteraction({
      user_id: userId,
      tmdb_id: tmdbId,
      media_type: mediaType,
      event_type: 'watchlist',
      event_value: 1,
      occurred_at: nowIso(),
    }).catch(() => {});
  }
  return state.watchlist[key];
}

export async function toggleFavorite(userId: number, tmdbId: number, mediaType: 'movie' | 'tv' = 'movie') {
  const key = `${userId}:${tmdbId}`;
  state.favorites[key] = !state.favorites[key];
  if (state.favorites[key]) state.favoritesMediaType[key] = mediaType;
  else delete state.favoritesMediaType[key];
  saveState(state);
  if (state.favorites[key]) {
    void ingestMlInteraction({
      user_id: userId,
      tmdb_id: tmdbId,
      media_type: mediaType,
      event_type: 'favorite',
      event_value: 1,
      occurred_at: nowIso(),
    }).catch(() => {});
  }
  return state.favorites[key];
}

export async function toggleWatched(userId: number, tmdbId: number, mediaType: 'movie' | 'tv' = 'movie') {
  const key = `${userId}:${tmdbId}`;
  state.watched[key] = !state.watched[key];
  if (state.watched[key]) state.watchedMediaType[key] = mediaType;
  else delete state.watchedMediaType[key];
  saveState(state);
  if (state.watched[key]) {
    void ingestMlInteraction({
      user_id: userId,
      tmdb_id: tmdbId,
      media_type: mediaType,
      event_type: 'watched',
      event_value: 1,
      occurred_at: nowIso(),
    }).catch(() => {});
  }
  return state.watched[key];
}

export async function setWatched(
  userId: number,
  tmdbId: number,
  watched: boolean,
  mediaType: 'movie' | 'tv' = 'movie'
) {
  const key = `${userId}:${tmdbId}`;
  state.watched[key] = watched;
  if (watched) state.watchedMediaType[key] = mediaType;
  else delete state.watchedMediaType[key];
  saveState(state);
  if (watched) {
    void ingestMlInteraction({
      user_id: userId,
      tmdb_id: tmdbId,
      media_type: mediaType,
      event_type: 'watched',
      event_value: 1,
      occurred_at: nowIso(),
    }).catch(() => {});
  }
  return state.watched[key];
}

export async function setRating(
  userId: number,
  tmdbId: number,
  rating: number,
  mediaType: 'movie' | 'tv' = 'movie'
) {
  const key = `${userId}:${tmdbId}`;
  state.ratings[key] = rating;
  state.ratingsMediaType[key] = mediaType;
  saveState(state);
  void ingestMlInteraction({
    user_id: userId,
    tmdb_id: tmdbId,
    media_type: mediaType,
    event_type: 'rating',
    event_value: rating,
    occurred_at: nowIso(),
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

  const clean = text.trim();
  if (!clean) return;
  const id = state.comments.length ? state.comments[state.comments.length - 1].id + 1 : 1;
  state.comments.push({
    id,
    user_id: userId,
    avatar_url: avatarUrl ?? null,
    nickname: nickname ?? 'user',
    tmdb_id: tmdbId,
    text: clean,
    parent_id: parentId ?? null,
    created_at: nowIso(),
  });
  saveState(state);
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
  return state.comments.filter((c) => c.tmdb_id === tmdbId);
}

export async function syncCommentAvatarsForUser(userId: number, avatarUrl: string | null) {
  const normalized = String(avatarUrl ?? '').trim() || null;
  let changed = false;
  state.comments = state.comments.map((comment) => {
    if (comment.user_id !== userId) return comment;
    if ((comment.avatar_url ?? null) === normalized) return comment;
    changed = true;
    return { ...comment, avatar_url: normalized };
  });
  if (changed) saveState(state);
}
