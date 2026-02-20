import Constants from 'expo-constants';

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
};

const extra = (Constants.expoConfig?.extra ?? {}) as {
  EXPO_PUBLIC_BACKEND_URL?: string;
  EXPO_PUBLIC_ADMIN_API_KEY?: string;
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

export async function backendCreateCinemaEvent(input: BackendCinemaInput) {
  const url = getBackendApiUrl('/api/cinema/events');
  if (!url) throw new Error('Backend URL missing.');

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  const adminKey = (extra.EXPO_PUBLIC_ADMIN_API_KEY ?? '').trim();
  if (adminKey) headers['x-admin-key'] = adminKey;

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

export async function backendResetAllData() {
  const url = getBackendApiUrl('/api/admin/reset-all');
  if (!url) return;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  const adminKey = (extra.EXPO_PUBLIC_ADMIN_API_KEY ?? '').trim();
  if (adminKey) headers['x-admin-key'] = adminKey;
  await requestJson<{ ok: boolean }>(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({}),
  });
}

export async function backendDeleteCloudinaryImage(imageUrl: string) {
  const url = getBackendApiUrl('/api/admin/cloudinary/delete-image');
  if (!url) return;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  const adminKey = (extra.EXPO_PUBLIC_ADMIN_API_KEY ?? '').trim();
  if (adminKey) headers['x-admin-key'] = adminKey;
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
  await requestJson<{ ok: boolean }>(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      image_url: imageUrl,
      user_id: userId,
    }),
  });
}

export async function backendGetCloudinaryUploadSignature(
  resourceType: 'image' | 'video',
  options?: { userId?: number | null; folder?: string | null }
) {
  const url = getBackendApiUrl('/api/media/cloudinary/sign-upload');
  if (!url) return null;
  try {
    return await requestJson<BackendCloudinarySignature>(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        resource_type: resourceType,
        user_id: options?.userId ?? null,
        folder: options?.folder ?? null,
      }),
    });
  } catch {
    return null;
  }
}
