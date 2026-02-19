import { getBackendApiUrl } from './cinema-backend';

export type PublicProfile = {
  user_id: number;
  nickname: string;
  name: string | null;
  bio: string | null;
  avatar_url: string | null;
  updated_at: string;
  followers: number;
  following: number;
  watchlist: any[];
  favorites: any[];
  watched: any[];
  rated: any[];
  favorite_actors: any[];
  favorite_directors: any[];
};

type ProfileSyncPayload = {
  user_id: number;
  nickname: string;
  name?: string | null;
  bio?: string | null;
  avatar_url?: string | null;
  privacy: {
    watchlist: boolean;
    favorites: boolean;
    watched: boolean;
    rated: boolean;
    favorite_actors: boolean;
    favorite_directors?: boolean;
  };
  watchlist: any[];
  favorites: any[];
  watched: any[];
  rated: any[];
  favorite_actors: any[];
  favorite_directors?: any[];
};

async function request<T>(url: string, init?: RequestInit) {
  const res = await fetch(url, init);
  if (!res.ok) {
    throw new Error(`Social backend error ${res.status}`);
  }
  return (await res.json()) as T;
}

export async function syncPublicProfile(payload: ProfileSyncPayload) {
  const url = getBackendApiUrl('/api/users/profile-sync');
  if (!url) return null;
  try {
    return await request<{ ok: true; profile: PublicProfile | null }>(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {
    return null;
  }
}

export async function getPublicProfile(userId: number) {
  const url = getBackendApiUrl(`/api/users/${userId}/public`);
  if (!url) return null;
  try {
    const payload = await request<{ profile: PublicProfile | null }>(url);
    return payload.profile;
  } catch {
    return null;
  }
}

export async function followTaste(followerId: number, targetId: number) {
  if (!Number.isFinite(Number(followerId)) || Number(followerId) <= 0) {
    throw new Error('Invalid follower id.');
  }
  if (!Number.isFinite(Number(targetId)) || Number(targetId) <= 0) {
    throw new Error('Invalid target id.');
  }
  const url = getBackendApiUrl(`/api/users/${targetId}/follow`);
  if (!url) return;
  await request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ follower_id: Number(followerId) }),
  });
}

export async function unfollowTaste(followerId: number, targetId: number) {
  if (!Number.isFinite(Number(followerId)) || Number(followerId) <= 0) {
    throw new Error('Invalid follower id.');
  }
  if (!Number.isFinite(Number(targetId)) || Number(targetId) <= 0) {
    throw new Error('Invalid target id.');
  }
  const url = getBackendApiUrl(`/api/users/${targetId}/follow?follower_id=${encodeURIComponent(String(followerId))}`);
  if (!url) return;
  await request(url, { method: 'DELETE' });
}

export async function getFollowingProfiles(userId: number) {
  const url = getBackendApiUrl(`/api/users/${userId}/following`);
  if (!url) return [];
  try {
    const payload = await request<{ users: PublicProfile[] }>(url);
    return payload.users ?? [];
  } catch {
    return [];
  }
}
