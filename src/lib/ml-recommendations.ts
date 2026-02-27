import Constants from 'expo-constants';
import { resolveBackendUserId } from './backend-session';

type MlRecoItem = {
  tmdb_id: number;
  score: number;
  reason: string;
};

type MlRecoResponse = {
  user_id: number;
  media_type: 'movie' | 'tv';
  model_rows: number;
  items: MlRecoItem[];
};

export type MlRecoExplain = {
  user_id: number;
  tmdb_id: number;
  media_type: 'movie' | 'tv';
  model_rows: number;
  already_seen: boolean;
  final_score: number;
  score_parts: {
    user_knn: number;
    item_knn: number;
    svd: number;
    follow_taste: number;
    popularity: number;
  };
  top_neighbor_users: { user_id: number; similarity: number; interaction_score: number }[];
  similar_seen_items: { tmdb_id: number; similarity: number; user_strength: number }[];
};

export type MlInteractionEvent = {
  user_id: number;
  tmdb_id: number;
  media_type: 'movie' | 'tv';
  event_type: 'watchlist' | 'watched' | 'favorite' | 'rating' | 'favorite_actor';
  event_value?: number | null;
  occurred_at?: string | null;
};

const extra = (Constants.expoConfig?.extra ?? {}) as {
  EXPO_PUBLIC_ML_API_URL?: string;
};
const ML_REQUEST_TIMEOUT_MS = 4500;

function mlBaseUrl() {
  return (process.env.EXPO_PUBLIC_ML_API_URL ?? extra.EXPO_PUBLIC_ML_API_URL ?? '')
    .trim()
    .replace(/\/+$/, '');
}

export function getMlApiBaseUrl() {
  return mlBaseUrl();
}

async function fetchWithTimeout(url: string, init?: RequestInit) {
  const controller = init?.signal ? null : new AbortController();
  const timeout = controller ? setTimeout(() => controller.abort(), ML_REQUEST_TIMEOUT_MS) : null;
  try {
    return await fetch(url, {
      ...(init ?? {}),
      signal: init?.signal ?? controller?.signal,
    });
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function isMixedContentBlockedOnWeb() {
  const baseUrl = mlBaseUrl();
  if (typeof window === 'undefined') return false;
  const pageProtocol = String(window.location?.protocol || '').toLowerCase();
  const apiProtocol = String(baseUrl.split(':')[0] || '').toLowerCase();
  return pageProtocol === 'https:' && apiProtocol === 'http';
}

function canUseMlApi() {
  return !!mlBaseUrl() && !isMixedContentBlockedOnWeb();
}

export function hasMlApi() {
  return canUseMlApi();
}

export async function checkMlApiHealth() {
  if (!canUseMlApi()) return false;
  const baseUrl = mlBaseUrl();
  const res = await fetchWithTimeout(`${baseUrl}/health`, { method: 'GET' });
  return res.ok;
}

export async function getMlRecommendations(
  userId: number,
  options?: { mediaType?: 'movie' | 'tv'; topN?: number }
) {
  if (!canUseMlApi()) return [];
  const resolvedUserId = resolveBackendUserId(userId) ?? Number(userId);
  if (!Number.isFinite(resolvedUserId) || resolvedUserId <= 0) return [];
  const baseUrl = mlBaseUrl();
  const mediaType = options?.mediaType ?? 'movie';
  const topN = options?.topN ?? 20;
  const url = `${baseUrl}/recommendations/${resolvedUserId}?media_type=${mediaType}&top_n=${topN}`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) {
    throw new Error(`ML service error: ${res.status}`);
  }
  const data = (await res.json()) as MlRecoResponse;
  return data.items ?? [];
}

export async function ingestMlInteraction(payload: MlInteractionEvent) {
  if (!canUseMlApi()) return;
  const resolvedUserId = resolveBackendUserId(payload.user_id) ?? Number(payload.user_id);
  if (!Number.isFinite(resolvedUserId) || resolvedUserId <= 0) return;
  const baseUrl = mlBaseUrl();
  try {
    await fetchWithTimeout(`${baseUrl}/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, user_id: resolvedUserId }),
    });
  } catch {
  }
}

export async function ingestMlInteractionsBatch(payload: MlInteractionEvent[]) {
  if (!canUseMlApi() || payload.length === 0) return;
  const normalizedPayload = payload
    .map((entry) => ({
      ...entry,
      user_id: resolveBackendUserId(entry.user_id) ?? Number(entry.user_id),
    }))
    .filter((entry) => Number.isFinite(entry.user_id) && Number(entry.user_id) > 0);
  if (normalizedPayload.length === 0) return;
  const baseUrl = mlBaseUrl();
  try {
    await fetchWithTimeout(`${baseUrl}/ingest/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(normalizedPayload),
    });
  } catch {
  }
}

export async function replaceMlUserInteractions(userId: number, payload: MlInteractionEvent[]) {
  if (!canUseMlApi()) return false;
  const resolvedUserId = resolveBackendUserId(userId) ?? Number(userId);
  if (!Number.isFinite(resolvedUserId) || resolvedUserId <= 0) return false;
  const normalizedPayload = payload
    .map((entry) => ({
      ...entry,
      user_id: resolvedUserId,
    }))
    .filter((entry) => Number.isFinite(entry.tmdb_id) && Number(entry.tmdb_id) > 0);
  const baseUrl = mlBaseUrl();
  try {
    const res = await fetchWithTimeout(`${baseUrl}/ingest/replace-user`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user_id: resolvedUserId,
        interactions: normalizedPayload,
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function syncMlFollowingGraph(followerId: number, followingIds: number[]) {
  if (!canUseMlApi()) return;
  const cleanFollowerId = Number(resolveBackendUserId(followerId) ?? followerId);
  if (!Number.isFinite(cleanFollowerId) || cleanFollowerId <= 0) return;
  const baseUrl = mlBaseUrl();
  const cleanFollowingIds = Array.from(
    new Set(
      (followingIds ?? [])
        .map((id) => Number(id))
        .filter((id) => Number.isFinite(id) && id > 0 && id !== cleanFollowerId)
    )
  );
  try {
    await fetchWithTimeout(`${baseUrl}/follows/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        follower_id: cleanFollowerId,
        following_ids: cleanFollowingIds,
      }),
    });
  } catch {
  }
}

export async function getMlRecommendationExplain(
  userId: number,
  tmdbId: number,
  options?: { mediaType?: 'movie' | 'tv' }
) {
  if (!canUseMlApi()) return null;
  const resolvedUserId = resolveBackendUserId(userId) ?? Number(userId);
  if (!Number.isFinite(resolvedUserId) || resolvedUserId <= 0) return null;
  const baseUrl = mlBaseUrl();
  const mediaType = options?.mediaType ?? 'movie';
  const url = `${baseUrl}/explain/${resolvedUserId}/${tmdbId}?media_type=${mediaType}`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) {
    throw new Error(`ML explain error: ${res.status}`);
  }
  return (await res.json()) as MlRecoExplain;
}
