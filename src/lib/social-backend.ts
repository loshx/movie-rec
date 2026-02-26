import { getBackendApiUrl } from './cinema-backend';
import {
  getBackendUserSession,
  getBackendUserTokenForUser,
  resolveBackendUserId,
  setBackendUserSession,
} from './backend-session';

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

type ProfileSyncResponse = {
  ok: true;
  profile: PublicProfile | null;
  session_token?: string | null;
  canonical_user_id?: number | null;
};

type SessionBootstrapResponse = {
  ok: true;
  session_token?: string | null;
  canonical_user_id?: number | null;
};

type DeletePublicAccountResponse = {
  ok: true;
  deleted_user_id: number;
  deleted_alias_ids?: number[];
};

async function request<T>(url: string, init?: RequestInit) {
  const res = await fetch(url, init);
  if (!res.ok) {
    throw new Error(`Social backend error ${res.status}`);
  }
  return (await res.json()) as T;
}

export async function syncPublicProfile(payload: ProfileSyncPayload) {
  const resolvedUserId = resolveBackendUserId(payload.user_id) ?? Number(payload.user_id);
  if (!Number.isFinite(resolvedUserId) || resolvedUserId <= 0) {
    throw new Error('Invalid user id.');
  }
  const url = getBackendApiUrl('/api/users/profile-sync');
  if (!url) {
    throw new Error('Backend URL missing.');
  }
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = getBackendUserTokenForUser(resolvedUserId);
  if (token) headers['x-user-token'] = token;
  const res = await request<ProfileSyncResponse>(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ ...payload, user_id: resolvedUserId }),
  });
  if (res?.session_token) {
    const canonicalUserId =
      Number.isFinite(Number(res.canonical_user_id)) && Number(res.canonical_user_id) > 0
        ? Number(res.canonical_user_id)
        : resolvedUserId;
    setBackendUserSession({ userId: canonicalUserId, token: String(res.session_token) });
  }
  return res;
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

export async function bootstrapBackendUserSession(userId: number, nickname: string) {
  const requestedUserId = Number(resolveBackendUserId(userId) ?? userId);
  if (!Number.isFinite(requestedUserId) || requestedUserId <= 0) return null;
  const cleanNickname = String(nickname || '').trim();
  if (!cleanNickname) return null;
  const url = getBackendApiUrl('/api/users/session/bootstrap');
  if (!url) return null;
  const tryBootstrap = async (candidateNickname: string) => {
    const cleanCandidate = String(candidateNickname || '').trim();
    if (!cleanCandidate) return null;
    try {
      const res = await request<SessionBootstrapResponse>(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id: requestedUserId,
          nickname: cleanCandidate,
        }),
      });
      if (res?.session_token) {
        const canonicalUserId =
          Number.isFinite(Number(res.canonical_user_id)) && Number(res.canonical_user_id) > 0
            ? Number(res.canonical_user_id)
            : requestedUserId;
        setBackendUserSession({ userId: canonicalUserId, token: String(res.session_token) });
      }
      return res;
    } catch {
      return null;
    }
  };

  const firstAttempt = await tryBootstrap(cleanNickname);
  if (firstAttempt) return firstAttempt;

  try {
    const publicProfile = await getPublicProfile(requestedUserId);
    const serverNickname = String(publicProfile?.nickname || '').trim();
    if (serverNickname && serverNickname.toLowerCase() !== cleanNickname.toLowerCase()) {
      return await tryBootstrap(serverNickname);
    }
    return null;
  } catch {
    return null;
  }
}

export async function deletePublicAccount(userId: number) {
  const cleanUserId = Number(resolveBackendUserId(userId) ?? userId);
  if (!Number.isFinite(cleanUserId) || cleanUserId <= 0) {
    throw new Error('Invalid user id.');
  }
  const session = getBackendUserSession();
  const preferredUserId =
    session && Number.isFinite(Number(session.userId)) && Number(session.userId) > 0
      ? Number(session.userId)
      : null;
  const candidateUserIds = Array.from(new Set([preferredUserId, cleanUserId].filter((id) => Number.isFinite(Number(id)) && Number(id) > 0)));

  let lastError: Error | null = null;
  let sawNotFound = false;

  for (const candidateUserId of candidateUserIds) {
    const url = getBackendApiUrl(`/api/users/${encodeURIComponent(String(candidateUserId))}`);
    if (!url) return null;
    const headers: Record<string, string> = {};
    const token = getBackendUserTokenForUser(candidateUserId);
    if (token) headers['x-user-token'] = token;
    const res = await fetch(url, { method: 'DELETE', headers });
    if (res.ok) {
      return (await res.json()) as DeletePublicAccountResponse;
    }
    let message = `Delete account failed (${res.status}).`;
    try {
      const payload = await res.json();
      if (payload?.error) message = String(payload.error);
    } catch {
    }
    if (res.status === 404 || /account not found|not found/i.test(message)) {
      sawNotFound = true;
      continue;
    }
    lastError = new Error(message);
    break;
  }

  if (lastError) throw lastError;
  if (sawNotFound) {
    return {
      ok: true,
      deleted_user_id: preferredUserId || cleanUserId,
      deleted_alias_ids: [cleanUserId],
    };
  }

  throw new Error('Delete account failed.');
}

export async function followTaste(followerId: number, targetId: number) {
  const cleanFollowerId = Number(resolveBackendUserId(followerId) ?? followerId);
  if (!Number.isFinite(cleanFollowerId) || cleanFollowerId <= 0) {
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
    body: JSON.stringify({ follower_id: cleanFollowerId }),
  });
}

export async function unfollowTaste(followerId: number, targetId: number) {
  const cleanFollowerId = Number(resolveBackendUserId(followerId) ?? followerId);
  if (!Number.isFinite(cleanFollowerId) || cleanFollowerId <= 0) {
    throw new Error('Invalid follower id.');
  }
  if (!Number.isFinite(Number(targetId)) || Number(targetId) <= 0) {
    throw new Error('Invalid target id.');
  }
  const url = getBackendApiUrl(
    `/api/users/${targetId}/follow?follower_id=${encodeURIComponent(String(cleanFollowerId))}`
  );
  if (!url) return;
  await request(url, { method: 'DELETE' });
}

export async function getFollowingProfiles(userId: number) {
  const resolvedUserId = resolveBackendUserId(userId) ?? Number(userId);
  if (!Number.isFinite(resolvedUserId) || resolvedUserId <= 0) return [];
  const url = getBackendApiUrl(`/api/users/${resolvedUserId}/following`);
  if (!url) return [];
  try {
    const payload = await request<{ users: PublicProfile[] }>(url);
    return payload.users ?? [];
  } catch {
    return [];
  }
}
