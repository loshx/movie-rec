import { getBackendApiUrl, hasBackendApi } from './cinema-backend';
import { getBackendUserTokenForUser, setBackendUserSession } from './backend-session';

export type BackendLocalAuthUser = {
  user_id: number;
  nickname: string;
  name: string | null;
  email: string | null;
  date_of_birth: string | null;
  country: string | null;
  bio: string | null;
  avatar_url: string | null;
  role: 'user' | 'admin';
  auth_provider: 'local' | 'google' | 'auth0';
  created_at?: string | null;
  updated_at?: string | null;
};

type BackendLocalAuthResponse = {
  ok?: boolean;
  available?: boolean;
  user?: BackendLocalAuthUser | null;
  session_token?: string | null;
  canonical_user_id?: number | null;
  error?: string;
};

export class BackendLocalAuthError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'BackendLocalAuthError';
    this.status = Number(status) || 0;
  }
}

function resolveCanonicalUserId(payload: BackendLocalAuthResponse | null) {
  const fromPayload =
    payload && Number.isFinite(Number(payload.canonical_user_id)) && Number(payload.canonical_user_id) > 0
      ? Number(payload.canonical_user_id)
      : null;
  if (fromPayload) return fromPayload;
  const fromUser = payload?.user && Number.isFinite(Number(payload.user.user_id)) ? Number(payload.user.user_id) : null;
  return fromUser && fromUser > 0 ? fromUser : null;
}

function maybePersistBackendSession(payload: BackendLocalAuthResponse | null) {
  const token = String(payload?.session_token || '').trim();
  if (!token) return;
  const canonicalUserId = resolveCanonicalUserId(payload);
  if (!canonicalUserId) return;
  setBackendUserSession({ userId: canonicalUserId, token });
}

async function requestBackend<T extends BackendLocalAuthResponse>(
  path: string,
  init?: RequestInit,
  options?: { userIdForToken?: number | null }
): Promise<T | null> {
  if (!hasBackendApi()) return null;
  const url = getBackendApiUrl(path);
  if (!url) return null;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init?.headers as Record<string, string> | undefined),
  };
  const token = getBackendUserTokenForUser(options?.userIdForToken ?? null);
  if (token) headers['x-user-token'] = token;

  try {
    const res = await fetch(url, { ...init, headers });
    let payload: BackendLocalAuthResponse = {};
    try {
      payload = (await res.json()) as BackendLocalAuthResponse;
    } catch {
      payload = {};
    }
    if (!res.ok) {
      const message =
        (payload?.error && String(payload.error).trim()) || `Backend auth request failed (${res.status}).`;
      throw new BackendLocalAuthError(res.status, message);
    }
    maybePersistBackendSession(payload);
    return payload as T;
  } catch (err) {
    if (err instanceof BackendLocalAuthError) throw err;
    return null;
  }
}

export async function backendLocalNicknameAvailable(nickname: string, excludeUserId?: number | null) {
  const cleanNickname = String(nickname || '').trim();
  if (!cleanNickname) return null;
  const suffix =
    Number.isFinite(Number(excludeUserId)) && Number(excludeUserId) > 0
      ? `&exclude_user_id=${encodeURIComponent(String(Number(excludeUserId)))}`
      : '';
  const payload = await requestBackend<BackendLocalAuthResponse>(
    `/api/auth/local/nickname-available?nickname=${encodeURIComponent(cleanNickname)}${suffix}`,
    {
      method: 'GET',
      headers: {},
    }
  );
  if (!payload) return null;
  return !!payload.available;
}

export async function backendLocalRegister(input: {
  nickname: string;
  password: string;
  name?: string | null;
}) {
  const payload = await requestBackend<BackendLocalAuthResponse>('/api/auth/local/register', {
    method: 'POST',
    body: JSON.stringify({
      nickname: String(input.nickname || '').trim(),
      password: String(input.password || ''),
      name: input.name ? String(input.name).trim() : null,
    }),
  });
  return payload;
}

export async function backendLocalLogin(input: { nickname: string; password: string }) {
  const payload = await requestBackend<BackendLocalAuthResponse>('/api/auth/local/login', {
    method: 'POST',
    body: JSON.stringify({
      nickname: String(input.nickname || '').trim(),
      password: String(input.password || ''),
    }),
  });
  return payload;
}

export async function backendLocalSyncCredentials(input: {
  userId: number;
  nickname: string;
  password: string;
}) {
  const payload = await requestBackend<BackendLocalAuthResponse>(
    '/api/auth/local/sync',
    {
      method: 'POST',
      body: JSON.stringify({
        user_id: Number(input.userId),
        nickname: String(input.nickname || '').trim(),
        password: String(input.password || ''),
      }),
    },
    { userIdForToken: input.userId }
  );
  return payload;
}
