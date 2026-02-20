import Constants from 'expo-constants';
import { getBackendUserTokenForUser, setBackendUserSession } from './backend-session';

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
};

const extra = (Constants.expoConfig?.extra ?? {}) as {
  EXPO_PUBLIC_BACKEND_URL?: string;
};

function backendBaseUrl() {
  const raw = (extra.EXPO_PUBLIC_BACKEND_URL ?? '').trim();
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

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    let message = `Backend error ${res.status}`;
    try {
      const payload = await res.json();
      if (payload?.error) message = String(payload.error);
    } catch {
    }
    throw new Error(message);
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

export async function backendResetAllData(options?: { adminKey?: string | null }) {
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
    body: JSON.stringify({}),
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
  const headers = withUserTokenHeader({ 'Content-Type': 'application/json' }, userId);
  await requestJson<{ ok: boolean }>(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      image_url: imageUrl,
      user_id: userId,
    }),
  });
}

export async function backendGetCloudinaryUploadSignature(
  resourceType: 'image' | 'video',
  options?: { userId?: number | null; folder?: string | null; adminKey?: string | null }
) {
  const url = getBackendApiUrl('/api/media/cloudinary/sign-upload');
  if (!url) {
    throw new Error('Backend URL missing. Set EXPO_PUBLIC_BACKEND_URL.');
  }
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    withUserTokenHeader(headers, options?.userId ?? null);
    const adminKey = normalizeAdminKey(options?.adminKey);
    if (adminKey) headers['x-admin-key'] = adminKey;
    const res = await requestJson<BackendCloudinarySignature>(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        resource_type: resourceType,
        user_id: options?.userId ?? null,
        folder: options?.folder ?? null,
      }),
    });
    if (res?.session_token && Number.isFinite(Number(options?.userId)) && Number(options?.userId) > 0) {
      setBackendUserSession({ userId: Number(options?.userId), token: String(res.session_token) });
    }
    return res;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown backend error.';
    throw new Error(`Cloudinary signature request failed: ${message}`);
  }
}
