import Constants from 'expo-constants';
import { getBackendUserTokenForUser, resolveBackendUserId, setBackendUserSession } from './backend-session';

export type BackendCinemaEvent = {
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

export type BackendCinemaInput = {
  title: string;
  description?: string | null;
  videoUrl: string;
  posterUrl?: string | null;
  tmdbId?: number | null;
  startAt: string;
  endAt: string;
  createdBy?: number | null;
};

export type BackendCinemaPollOption = {
  id: string;
  title: string;
  poster_url: string | null;
  tmdb_id: number | null;
  votes: number;
  percent: number;
};

export type BackendCinemaPoll = {
  id: number;
  question: string;
  status: 'open' | 'closed';
  total_votes: number;
  user_vote_option_id: string | null;
  options: BackendCinemaPollOption[];
  created_at: string;
  updated_at: string;
  expires_at: string;
};

export type BackendCloudinarySignature = {
  resource_type: 'image' | 'video';
  upload_url: string;
  cloud_name: string;
  api_key: string;
  timestamp: number;
  signature: string;
  public_id: string;
  folder: string;
  session_token?: string | null;
  canonical_user_id?: number | null;
};

const extra = (Constants.expoConfig?.extra ?? {}) as {
  EXPO_PUBLIC_BACKEND_URL?: string;
};
const BACKEND_REQUEST_TIMEOUT_MS = 6000;

function backendBaseUrl() {
  const raw = (process.env.EXPO_PUBLIC_BACKEND_URL ?? extra.EXPO_PUBLIC_BACKEND_URL ?? '').trim();
  if (!raw) return null;
  return raw.replace(/\/+$/, '');
}

export function hasBackendApi() {
  return !!backendBaseUrl();
}

export function getBackendApiUrl(path: string) {
  const base = backendBaseUrl();
  if (!base) return null;
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}

class BackendRequestError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'BackendRequestError';
    this.status = Number(status) || 0;
  }
}

function rethrowIfMissingCinemaPollRoute(error: unknown): never | void {
  if (error instanceof BackendRequestError && error.status === 404) {
    throw new Error('Cinema poll endpoint is missing on backend. Deploy latest backend to Render and retry.');
  }
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const controller = init?.signal ? null : new AbortController();
  const timeout = controller
    ? setTimeout(() => controller.abort(), BACKEND_REQUEST_TIMEOUT_MS)
    : null;
  let res: Response;
  try {
    res = await fetch(url, {
      ...(init ?? {}),
      signal: init?.signal ?? controller?.signal,
    });
  } catch (err) {
    if ((err as any)?.name === 'AbortError') {
      throw new Error('Backend request timeout.');
    }
    throw err;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
  if (!res.ok) {
    let message = `Backend error ${res.status}`;
    try {
      const payload = await res.json();
      if (payload?.error) message = String(payload.error);
    } catch {
    }
    throw new BackendRequestError(res.status, message);
  }
  return (await res.json()) as T;
}

function normalizeAdminKey(adminKey?: string | null) {
  return String(adminKey ?? '').trim();
}

function withUserTokenHeader(headers: Record<string, string>, userId?: number | null) {
  const token = getBackendUserTokenForUser(userId);
  if (token) headers['x-user-token'] = token;
  return headers;
}

export async function backendGetCurrentCinemaEvent(nowIsoValue = new Date().toISOString()) {
  const url = getBackendApiUrl(`/api/cinema/current?now=${encodeURIComponent(nowIsoValue)}`);
  if (!url) return null;
  const payload = await requestJson<{ event: BackendCinemaEvent | null }>(url);
  return payload.event;
}

export async function backendGetLatestCinemaEvent() {
  const url = getBackendApiUrl('/api/cinema/latest');
  if (!url) return null;
  const payload = await requestJson<{ event: BackendCinemaEvent | null }>(url);
  return payload.event;
}

export async function backendGetCurrentCinemaPoll(userId?: number | null) {
  const search = new URLSearchParams();
  const cleanUserId = Number(resolveBackendUserId(userId ?? null) ?? 0);
  if (Number.isFinite(cleanUserId) && cleanUserId > 0) {
    search.set('user_id', String(cleanUserId));
  }
  const url = getBackendApiUrl(`/api/cinema/poll/current${search.toString() ? `?${search.toString()}` : ''}`);
  if (!url) return null;
  try {
    const payload = await requestJson<{ poll: BackendCinemaPoll | null }>(url);
    return payload.poll ?? null;
  } catch (error) {
    rethrowIfMissingCinemaPollRoute(error);
    throw error;
  }
}

export async function backendCreateCinemaPoll(
  input: {
    question?: string | null;
    options: Array<{
      id?: string;
      title: string;
      poster_url: string;
      tmdb_id?: number | null;
    }>;
  },
  options?: { adminKey?: string | null }
) {
  const url = getBackendApiUrl('/api/cinema/poll');
  if (!url) throw new Error('Backend URL missing.');
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  const adminKey = normalizeAdminKey(options?.adminKey);
  if (!adminKey) throw new Error('Admin API key is required.');
  headers['x-admin-key'] = adminKey;
  try {
    const payload = await requestJson<{ poll: BackendCinemaPoll | null }>(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        question: input.question ?? null,
        options: input.options ?? [],
      }),
    });
    return payload.poll ?? null;
  } catch (error) {
    rethrowIfMissingCinemaPollRoute(error);
    throw error;
  }
}

export async function backendVoteCinemaPoll(pollId: number, userId: number, optionId: string) {
  const cleanPollId = Number(pollId);
  const cleanUserId = Number(resolveBackendUserId(userId) ?? userId);
  const cleanOptionId = String(optionId || '').trim();
  if (!Number.isFinite(cleanPollId) || cleanPollId <= 0) throw new Error('Invalid poll id.');
  if (!Number.isFinite(cleanUserId) || cleanUserId <= 0) throw new Error('Invalid user id.');
  if (!cleanOptionId) throw new Error('option_id is required.');
  const url = getBackendApiUrl(`/api/cinema/poll/${encodeURIComponent(String(cleanPollId))}/vote`);
  if (!url) throw new Error('Backend URL missing.');
  try {
    const payload = await requestJson<{ poll: BackendCinemaPoll | null }>(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        user_id: cleanUserId,
        option_id: cleanOptionId,
      }),
    });
    return payload.poll ?? null;
  } catch (error) {
    rethrowIfMissingCinemaPollRoute(error);
    throw error;
  }
}

export async function backendCloseCinemaPoll(pollId: number, options?: { adminKey?: string | null }) {
  const cleanPollId = Number(pollId);
  if (!Number.isFinite(cleanPollId) || cleanPollId <= 0) throw new Error('Invalid poll id.');
  const url = getBackendApiUrl(`/api/cinema/poll/${encodeURIComponent(String(cleanPollId))}/close`);
  if (!url) throw new Error('Backend URL missing.');
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  const adminKey = normalizeAdminKey(options?.adminKey);
  if (!adminKey) throw new Error('Admin API key is required.');
  headers['x-admin-key'] = adminKey;
  try {
    const payload = await requestJson<{ poll: BackendCinemaPoll | null }>(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({}),
    });
    return payload.poll ?? null;
  } catch (error) {
    rethrowIfMissingCinemaPollRoute(error);
    throw error;
  }
}

export async function backendCreateCinemaEvent(
  input: BackendCinemaInput,
  options?: { adminKey?: string | null }
) {
  const url = getBackendApiUrl('/api/cinema/events');
  if (!url) throw new Error('Backend URL missing.');

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  const adminKey = normalizeAdminKey(options?.adminKey);
  if (!adminKey) throw new Error('Admin API key is required.');
  headers['x-admin-key'] = adminKey;

  const payload = await requestJson<{ event: BackendCinemaEvent }>(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      title: input.title,
      description: input.description ?? null,
      video_url: input.videoUrl,
      poster_url: input.posterUrl ?? null,
      tmdb_id: input.tmdbId ?? null,
      start_at: input.startAt,
      end_at: input.endAt,
      created_by: input.createdBy ?? null,
    }),
  });
  return payload.event;
}

export async function backendResetAllData(options?: {
  adminKey?: string | null;
  keepAdminUserId?: number | null;
  keepAdminNickname?: string | null;
}) {
  const url = getBackendApiUrl('/api/admin/reset-all');
  if (!url) return;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  const adminKey = normalizeAdminKey(options?.adminKey);
  if (!adminKey) throw new Error('Admin API key is required.');
  headers['x-admin-key'] = adminKey;
  await requestJson<{ ok: boolean }>(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      keep_admin_user_id:
        Number.isFinite(Number(options?.keepAdminUserId)) && Number(options?.keepAdminUserId) > 0
          ? Number(options?.keepAdminUserId)
          : null,
      keep_admin_nickname: String(options?.keepAdminNickname ?? '').trim() || null,
    }),
  });
}

export async function backendDeleteCloudinaryImage(
  imageUrl: string,
  options?: { adminKey?: string | null }
) {
  const url = getBackendApiUrl('/api/admin/cloudinary/delete-image');
  if (!url) return;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  const adminKey = normalizeAdminKey(options?.adminKey);
  if (!adminKey) throw new Error('Admin API key is required.');
  headers['x-admin-key'] = adminKey;
  await requestJson<{ ok: boolean }>(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      image_url: imageUrl,
    }),
  });
}

export async function backendDeleteOwnCloudinaryImage(imageUrl: string, userId: number) {
  const url = getBackendApiUrl('/api/media/cloudinary/delete-image');
  if (!url) return;
  const routeUserId = Number(resolveBackendUserId(userId) ?? userId);
  const headers = withUserTokenHeader({ 'Content-Type': 'application/json' }, routeUserId);
  await requestJson<{ ok: boolean }>(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      image_url: imageUrl,
      user_id: routeUserId,
    }),
  });
}

export async function backendGetCloudinaryUploadSignature(
  resourceType: 'image' | 'video',
  options?: { userId?: number | null; folder?: string | null; adminKey?: string | null; nicknames?: string[] | null }
) {
  const url = getBackendApiUrl('/api/media/cloudinary/sign-upload');
  if (!url) {
    throw new Error('Backend URL missing. Set EXPO_PUBLIC_BACKEND_URL.');
  }
  const routeUserId =
    Number(resolveBackendUserId(options?.userId ?? null) ?? 0) > 0
      ? Number(resolveBackendUserId(options?.userId ?? null) ?? 0)
      : Number(options?.userId ?? 0) > 0
        ? Number(options?.userId ?? 0)
        : null;
  const requestSignature = async () => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    withUserTokenHeader(headers, routeUserId);
    const adminKey = normalizeAdminKey(options?.adminKey);
    if (adminKey) headers['x-admin-key'] = adminKey;
    const res = await requestJson<BackendCloudinarySignature>(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        resource_type: resourceType,
        user_id: routeUserId,
        folder: options?.folder ?? null,
      }),
    });
    if (res?.session_token && routeUserId && routeUserId > 0) {
      const canonicalUserId =
        Number.isFinite(Number(res.canonical_user_id)) && Number(res.canonical_user_id) > 0
          ? Number(res.canonical_user_id)
          : routeUserId;
      setBackendUserSession({ userId: canonicalUserId, token: String(res.session_token) });
    }
    return res;
  };
  const bootstrapSessionIfPossible = async () => {
    const userId = Number(routeUserId ?? 0);
    if (!Number.isFinite(userId) || userId <= 0) return false;
    const bootstrapUrl = getBackendApiUrl('/api/users/session/bootstrap');
    if (!bootstrapUrl) return false;
    const nicknames = Array.isArray(options?.nicknames)
      ? options.nicknames
          .map((x) => String(x ?? '').trim())
          .filter((x, idx, arr) => x.length > 0 && arr.indexOf(x) === idx)
      : [];
    const publicProfileUrl = getBackendApiUrl(`/api/users/${encodeURIComponent(String(userId))}/public`);
    if (publicProfileUrl) {
      try {
        const publicProfilePayload = await requestJson<{ profile?: { nickname?: string | null } | null }>(
          publicProfileUrl
        );
        const serverNickname = String(publicProfilePayload?.profile?.nickname ?? '').trim();
        if (serverNickname && !nicknames.some((x) => x.toLowerCase() === serverNickname.toLowerCase())) {
          nicknames.push(serverNickname);
        }
      } catch {
      }
    }
    for (const nickname of nicknames) {
      try {
        const payload = await requestJson<{ session_token?: string | null; canonical_user_id?: number | null }>(bootstrapUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            user_id: userId,
            nickname,
          }),
        });
        if (payload?.session_token) {
          const canonicalUserId =
            Number.isFinite(Number(payload.canonical_user_id)) && Number(payload.canonical_user_id) > 0
              ? Number(payload.canonical_user_id)
              : userId;
          setBackendUserSession({ userId: canonicalUserId, token: String(payload.session_token) });
          return true;
        }
      } catch {
      }
    }
    return false;
  };
  try {
    return await requestSignature();
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown backend error.';
    const missingOrInvalidSession = /session missing|invalid user session token/i.test(message);
    if (missingOrInvalidSession && (await bootstrapSessionIfPossible())) {
      return await requestSignature();
    }
    throw new Error(`Cloudinary signature request failed: ${message}`);
  }
}
