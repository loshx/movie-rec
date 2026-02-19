import Constants from 'expo-constants';

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

const BASE_URL = extra.EXPO_PUBLIC_ML_API_URL?.trim() || '';

export function hasMlApi() {
  return !!BASE_URL;
}

export async function getMlRecommendations(
  userId: number,
  options?: { mediaType?: 'movie' | 'tv'; topN?: number }
) {
  if (!BASE_URL) return [];
  const mediaType = options?.mediaType ?? 'movie';
  const topN = options?.topN ?? 20;
  const url = `${BASE_URL}/recommendations/${userId}?media_type=${mediaType}&top_n=${topN}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`ML service error: ${res.status}`);
  }
  const data = (await res.json()) as MlRecoResponse;
  return data.items ?? [];
}

export async function ingestMlInteraction(payload: MlInteractionEvent) {
  if (!BASE_URL) return;
  await fetch(`${BASE_URL}/ingest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export async function ingestMlInteractionsBatch(payload: MlInteractionEvent[]) {
  if (!BASE_URL || payload.length === 0) return;
  await fetch(`${BASE_URL}/ingest/batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export async function syncMlFollowingGraph(followerId: number, followingIds: number[]) {
  if (!BASE_URL) return;
  const cleanFollowerId = Number(followerId);
  if (!Number.isFinite(cleanFollowerId) || cleanFollowerId <= 0) return;
  const cleanFollowingIds = Array.from(
    new Set(
      (followingIds ?? [])
        .map((id) => Number(id))
        .filter((id) => Number.isFinite(id) && id > 0 && id !== cleanFollowerId)
    )
  );
  await fetch(`${BASE_URL}/follows/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      follower_id: cleanFollowerId,
      following_ids: cleanFollowingIds,
    }),
  });
}

export async function getMlRecommendationExplain(
  userId: number,
  tmdbId: number,
  options?: { mediaType?: 'movie' | 'tv' }
) {
  if (!BASE_URL) return null;
  const mediaType = options?.mediaType ?? 'movie';
  const url = `${BASE_URL}/explain/${userId}/${tmdbId}?media_type=${mediaType}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`ML explain error: ${res.status}`);
  }
  return (await res.json()) as MlRecoExplain;
}
