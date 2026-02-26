import { getDb } from './database';
import { GALLERY_SEED } from '@/data/gallery-seed';
import { getBackendApiUrl, hasBackendApi } from '@/lib/cinema-backend';
import { getBackendUserTokenForUser, resolveBackendUserId } from '@/lib/backend-session';

export type GalleryDetails = Record<string, string>;

export type GalleryItem = {
  id: string;
  title: string;
  image: string;
  height: number;
  tag: string;
  shotId?: string | null;
  titleHeader?: string | null;
  imageId?: string | null;
  imageUrl?: string | null;
  paletteHex: string[];
  details: GalleryDetails;
};

export type GalleryFeedItem = GalleryItem & {
  likesCount: number;
  commentsCount: number;
  likedByMe: boolean;
  favoritedByMe: boolean;
};

export type GalleryComment = {
  id: number;
  galleryId: number;
  userId: number;
  nickname: string;
  avatarUrl: string | null;
  text: string;
  parentId: number | null;
  createdAt: string;
};

const SEED_ITEMS: Omit<GalleryItem, 'id'>[] = GALLERY_SEED;

type RemoteGalleryItem = {
  id: number | string;
  title: string;
  image: string;
  tag: string;
  height: number;
  shot_id?: string | null;
  title_header?: string | null;
  image_id?: string | null;
  image_url?: string | null;
  palette_hex?: string[] | null;
  details?: GalleryDetails | null;
  likes_count?: number;
  comments_count?: number;
  liked_by_me?: boolean | number;
  favorited_by_me?: boolean | number;
};

type RemoteGalleryComment = {
  id: number;
  gallery_id: number;
  user_id: number;
  nickname: string;
  avatar_url?: string | null;
  text: string;
  parent_id?: number | null;
  created_at: string;
};

async function requestBackendJson<T>(
  path: string,
  init?: RequestInit,
  options?: { userIdForToken?: number | null }
): Promise<T | null> {
  if (!hasBackendApi()) return null;
  const url = getBackendApiUrl(path);
  if (!url) return null;
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(init?.headers as Record<string, string> | undefined),
    };
    const token = getBackendUserTokenForUser(options?.userIdForToken ?? null);
    if (token) headers['x-user-token'] = token;
    const res = await fetch(url, { ...init, headers });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

function resolveUserRouteId(userId: number): number | null {
  if (hasBackendApi()) {
    const sessionUserId = resolveBackendUserId();
    if (Number.isFinite(Number(sessionUserId)) && Number(sessionUserId) > 0) {
      return Number(sessionUserId);
    }
    return null;
  }
  const localUserId = Number(userId);
  if (Number.isFinite(localUserId) && localUserId > 0) {
    return localUserId;
  }
  return null;
}

function mapRemoteGalleryItem(row: RemoteGalleryItem): GalleryItem {
  const image = resolveGalleryImage({
    image: row.image,
    imageUrl: row.image_url,
    shotId: row.shot_id,
    imageId: row.image_id,
    title: row.title,
  });
  return {
    id: String(row.id),
    title: row.title,
    image,
    tag: row.tag,
    height: normalizeHeight(row.height),
    shotId: row.shot_id ?? null,
    titleHeader: row.title_header ?? null,
    imageId: row.image_id ?? null,
    imageUrl: normalizeRemoteImageUri(row.image_url) || image,
    paletteHex: Array.isArray(row.palette_hex)
      ? row.palette_hex.map((x) => String(x)).filter((x) => /^#[0-9a-fA-F]{6}$/.test(x))
      : [],
    details: (row.details ?? {}) as GalleryDetails,
  };
}

function mapRemoteGalleryFeedItem(row: RemoteGalleryItem): GalleryFeedItem {
  const base = mapRemoteGalleryItem(row);
  return {
    ...base,
    likesCount: Number(row.likes_count ?? 0),
    commentsCount: Number(row.comments_count ?? 0),
    likedByMe: !!row.liked_by_me,
    favoritedByMe: !!row.favorited_by_me,
  };
}

function mapRemoteGalleryComment(row: RemoteGalleryComment): GalleryComment {
  return {
    id: Number(row.id),
    galleryId: Number(row.gallery_id),
    userId: Number(row.user_id),
    nickname: String(row.nickname || `user_${row.user_id}`),
    avatarUrl: row.avatar_url ?? null,
    text: String(row.text || ''),
    parentId: row.parent_id ?? null,
    createdAt: String(row.created_at || nowIso()),
  };
}

function isRestrictedShotdeckUrl(value: string) {
  return /^https?:\/\/(?:www\.)?shotdeck\.com\/assets\/images\/stills\//i.test(value);
}

function isLegacyShotdeckPlaceholder(value: string) {
  return value.startsWith('data:image/svg+xml;utf8,') && /source restricted/i.test(value);
}

function fallbackGalleryImage(item: { imageId?: string | null; shotId?: string | null; title?: string | null }) {
  const rawSeed =
    String(item.imageId ?? '').trim() ||
    String(item.shotId ?? '').trim() ||
    String(item.title ?? '').trim() ||
    'gallery';
  const seed = encodeURIComponent(rawSeed.replace(/\s+/g, '-').slice(0, 80));
  return `https://picsum.photos/seed/${seed}/600/900`;
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeHeight(value: unknown) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 240;
  return Math.max(160, Math.min(520, Math.round(parsed)));
}

function normalizeRemoteImageUri(uri: string | null | undefined) {
  const clean = String(uri ?? '').trim();
  if (!clean) return '';
  if (clean.startsWith('data:image/')) return clean;
  if (clean.startsWith('http://') || clean.startsWith('https://') || clean.startsWith('data:image/')) {
    return clean;
  }
  return '';
}

function deriveShotdeckUrl(item: { shotId?: string | null; imageId?: string | null }) {
  const id = String(item.imageId ?? '').trim() || String(item.shotId ?? '').trim();
  if (!id) return '';
  return `https://shotdeck.com/assets/images/stills/${id}.jpg`;
}

function resolveGalleryImage(item: {
  image?: string | null;
  imageUrl?: string | null;
  shotId?: string | null;
  imageId?: string | null;
  title?: string | null;
}) {
  const directRaw = String(item.image ?? '').trim();
  const direct = normalizeRemoteImageUri(directRaw);
  if (direct && !isRestrictedShotdeckUrl(direct) && !isLegacyShotdeckPlaceholder(direct)) return direct;

  const urlRaw = String(item.imageUrl ?? '').trim();
  const url = normalizeRemoteImageUri(urlRaw);
  if (url && !isRestrictedShotdeckUrl(url) && !isLegacyShotdeckPlaceholder(url)) return url;

  const derivedShotdeck = deriveShotdeckUrl(item);
  if (isRestrictedShotdeckUrl(directRaw) || isRestrictedShotdeckUrl(urlRaw) || isRestrictedShotdeckUrl(derivedShotdeck)) {
    return fallbackGalleryImage(item);
  }

  const normalizedDerived = normalizeRemoteImageUri(derivedShotdeck);
  if (normalizedDerived) return normalizedDerived;
  return fallbackGalleryImage(item);
}

function dedupeKey(item: { imageId?: string | null; shotId?: string | null; title?: string | null }) {
  const imageId = String(item.imageId ?? '').trim().toLowerCase();
  const shotId = String(item.shotId ?? '').trim().toLowerCase();
  if (imageId || shotId) return `${imageId}::${shotId}`;
  return `title:${String(item.title ?? '').trim().toLowerCase()}`;
}

function titleKey(value: string | null | undefined) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function dedupeMappedGalleryRows<T extends { title?: string | null; imageId?: string | null; shotId?: string | null }>(
  rows: T[]
) {
  const seen = new Set<string>();
  const seenTitle = new Set<string>();
  return rows.filter((row) => {
    const key = dedupeKey({
      imageId: row.imageId,
      shotId: row.shotId,
      title: row.title ?? '',
    });
    const tKey = titleKey(row.title);
    if (seen.has(key)) return false;
    if (seenTitle.has(tKey)) return false;
    seen.add(key);
    seenTitle.add(tKey);
    return true;
  });
}

function parsePaletteJson(raw: string | null | undefined) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((x) => String(x)).filter((x) => /^#[0-9a-fA-F]{6}$/.test(x));
  } catch {
    return [];
  }
}

function parseDetailsJson(raw: string | null | undefined): GalleryDetails {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: GalleryDetails = {};
    for (const [k, v] of Object.entries(parsed || {})) {
      const key = String(k).trim();
      const value = String(v ?? '').trim();
      if (!key || !value) continue;
      out[key] = value;
    }

    const rawTags = String(out.TAGS ?? '').trim();
    if (!rawTags.includes('\n')) return out;

    const lines = rawTags
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (!lines.length) return out;

    const detailLine = /^([A-Z][A-Z0-9 /&().'_-]{1,80}):\s*(.+)$/;
    let tags = lines[0];
    let changed = false;
    for (let i = 1; i < lines.length; i += 1) {
      const line = lines[i];
      if (/^SIMILAR SHOTS\b/i.test(line) || /^SEE MORE SIMILAR SHOTS\b/i.test(line)) {
        changed = true;
        continue;
      }
      const match = line.match(detailLine);
      if (match) {
        const detailKey = match[1].trim();
        const detailValue = match[2].trim();
        if (detailKey && detailValue) {
          if (!out[detailKey]) out[detailKey] = detailValue;
          changed = true;
          continue;
        }
      }
      tags = tags ? `${tags}, ${line}` : line;
      changed = true;
    }
    if (changed) out.TAGS = tags;
    return out;
  } catch {
    return {};
  }
}

let ensureSeededOncePromise: Promise<void> | null = null;
const GALLERY_SEED_DISABLED_FLAG_KEY = 'gallery_seed_disabled';

async function ensureGalleryFlagsTable() {
  const db = await getDb();
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS app_flags (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  return db;
}

async function isGallerySeedDisabledNative() {
  const db = await ensureGalleryFlagsTable();
  const row = await db.getFirstAsync<{ value: string }>('SELECT value FROM app_flags WHERE key = ?', GALLERY_SEED_DISABLED_FLAG_KEY);
  return String(row?.value || '').trim() === '1';
}

async function setGallerySeedDisabledNative(disabled: boolean) {
  const db = await ensureGalleryFlagsTable();
  await db.runAsync(
    'INSERT OR REPLACE INTO app_flags (key, value) VALUES (?, ?)',
    GALLERY_SEED_DISABLED_FLAG_KEY,
    disabled ? '1' : '0'
  );
}

async function ensureSeeded() {
  const db = await getDb();
  const seedDisabled = await isGallerySeedDisabledNative();
  const seedByTitle = new Map(SEED_ITEMS.map((item) => [titleKey(item.title), item]));
  const existingRows = await db.getAllAsync<{
    id: number;
    title: string;
    image: string | null;
    shot_id: string | null;
    image_id: string | null;
    image_url: string | null;
  }>(
    `
    SELECT id, title, image, shot_id, image_id, image_url
    FROM gallery_items
    ORDER BY id ASC
    `
  );

  // Normalize existing rows so mobile/web can always load a valid remote URL.
  for (const row of existingRows) {
    const seed = seedByTitle.get(titleKey(row.title));
    const seedResolved = seed ? resolveGalleryImage(seed) : '';
    const resolved = resolveGalleryImage({
      image: row.image,
      imageUrl: row.image_url,
      shotId: row.shot_id,
      imageId: row.image_id,
    });
    const targetImage = resolved || seedResolved;
    if (!targetImage) continue;

    const nextShotId = String(row.shot_id ?? '').trim() || String(seed?.shotId ?? '').trim() || null;
    const nextImageId = String(row.image_id ?? '').trim() || String(seed?.imageId ?? '').trim() || null;
    const nextImageUrl =
      normalizeRemoteImageUri(row.image_url) ||
      normalizeRemoteImageUri(seed?.imageUrl) ||
      targetImage;

    await db.runAsync(
      'UPDATE gallery_items SET image = ?, image_url = ?, shot_id = COALESCE(?, shot_id), image_id = COALESCE(?, image_id) WHERE id = ?',
      targetImage,
      nextImageUrl,
      nextShotId,
      nextImageId,
      row.id
    );
  }

  // Remove historical duplicates by title, keep the row with strongest identifiers.
  const normalizedRows = await db.getAllAsync<{
    id: number;
    title: string;
    image: string | null;
    shot_id: string | null;
    image_id: string | null;
    image_url: string | null;
  }>('SELECT id, title, image, shot_id, image_id, image_url FROM gallery_items ORDER BY id DESC');
  const bestByTitle = new Map<string, number>();
  const duplicateIds: number[] = [];
  for (const row of normalizedRows) {
    const key = titleKey(row.title);
    const score =
      (normalizeRemoteImageUri(row.image) ? 3 : 0) +
      (normalizeRemoteImageUri(row.image_url) ? 2 : 0) +
      (String(row.shot_id ?? '').trim() ? 1 : 0) +
      (String(row.image_id ?? '').trim() ? 1 : 0);
    if (!bestByTitle.has(key)) {
      bestByTitle.set(key, row.id);
      continue;
    }
    const currentBestId = bestByTitle.get(key)!;
    const currentBest = normalizedRows.find((x) => x.id === currentBestId);
    const currentScore =
      (normalizeRemoteImageUri(currentBest?.image) ? 3 : 0) +
      (normalizeRemoteImageUri(currentBest?.image_url) ? 2 : 0) +
      (String(currentBest?.shot_id ?? '').trim() ? 1 : 0) +
      (String(currentBest?.image_id ?? '').trim() ? 1 : 0);
    if (score > currentScore) {
      duplicateIds.push(currentBestId);
      bestByTitle.set(key, row.id);
    } else {
      duplicateIds.push(row.id);
    }
  }
  for (const id of duplicateIds) {
    await db.runAsync('DELETE FROM gallery_items WHERE id = ?', id);
  }

  const existingKeys = new Set(
    normalizedRows
      .filter((row) => !duplicateIds.includes(row.id))
      .map((row) =>
      dedupeKey({
        imageId: row.image_id,
        shotId: row.shot_id,
        title: row.title,
      })
      )
  );

  if (seedDisabled) return;

  for (const item of SEED_ITEMS) {
    const key = dedupeKey(item);
    if (existingKeys.has(key)) continue;
    const resolvedImage = resolveGalleryImage(item);
    if (!resolvedImage) continue;

    await db.runAsync(
      `INSERT INTO gallery_items
       (title, image, tag, height, shot_id, title_header, image_id, image_url, palette_json, details_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      item.title,
      resolvedImage,
      item.tag,
      normalizeHeight(item.height),
      item.shotId ?? null,
      item.titleHeader ?? null,
      item.imageId ?? null,
      normalizeRemoteImageUri(item.imageUrl) || resolvedImage,
      JSON.stringify(item.paletteHex ?? []),
      JSON.stringify(item.details ?? {}),
      nowIso()
    );
    existingKeys.add(key);
  }
}

async function ensureSeededOnce() {
  if (!ensureSeededOncePromise) {
    ensureSeededOncePromise = ensureSeeded().catch((error) => {
      ensureSeededOncePromise = null;
      throw error;
    });
  }
  return ensureSeededOncePromise;
}

export async function getGalleryItems(opts?: { userId?: number; query?: string }): Promise<GalleryFeedItem[]> {
  if (hasBackendApi()) {
    const requestedUserId = Number(opts?.userId ?? 0);
    const routeUserId = requestedUserId > 0 ? resolveUserRouteId(requestedUserId) : null;
    const search = new URLSearchParams();
    if (routeUserId && routeUserId > 0) {
      search.set('user_id', String(routeUserId));
    }
    const query = String(opts?.query ?? '').trim();
    if (query) search.set('query', query);
    const payload = await requestBackendJson<{ items?: RemoteGalleryItem[] }>(
      `/api/gallery${search.toString() ? `?${search.toString()}` : ''}`,
      undefined,
      routeUserId && routeUserId > 0 ? { userIdForToken: routeUserId } : undefined
    );
    if (Array.isArray(payload?.items)) {
      const mapped = payload.items.map(mapRemoteGalleryFeedItem).filter((item) => !!item.image);
      return dedupeMappedGalleryRows(mapped);
    }
    return [];
  }

  await ensureSeededOnce();
  const db = await getDb();
  const userId = Number(opts?.userId ?? 0);
  const query = String(opts?.query ?? '').trim().toLowerCase();
  const hasQuery = query.length > 0;
  const likeQuery = `%${query}%`;
  const rows = await db.getAllAsync<{
    id: number;
    title: string;
    image: string;
    tag: string;
    height: number;
    shot_id: string | null;
    title_header: string | null;
    image_id: string | null;
    image_url: string | null;
    palette_json: string | null;
    details_json: string | null;
    likes_count: number;
    comments_count: number;
    liked_by_me: number;
    favorited_by_me: number;
  }>(
    `
    SELECT
      gi.id, gi.title, gi.image, gi.tag, gi.height, gi.shot_id, gi.title_header, gi.image_id, gi.image_url, gi.palette_json, gi.details_json,
      (SELECT COUNT(*) FROM gallery_likes gl WHERE gl.gallery_id = gi.id) as likes_count,
      (SELECT COUNT(*) FROM gallery_comments gc WHERE gc.gallery_id = gi.id) as comments_count,
      (SELECT COUNT(*) FROM gallery_likes gl2 WHERE gl2.gallery_id = gi.id AND gl2.user_id = ?) as liked_by_me,
      (SELECT COUNT(*) FROM gallery_favorites gf2 WHERE gf2.gallery_id = gi.id AND gf2.user_id = ?) as favorited_by_me
    FROM gallery_items gi
    WHERE (? = 0)
      OR LOWER(gi.title) LIKE ?
      OR LOWER(gi.tag) LIKE ?
      OR LOWER(COALESCE(gi.title_header, '')) LIKE ?
      OR LOWER(COALESCE(gi.details_json, '')) LIKE ?
    ORDER BY datetime(gi.created_at) DESC
    `,
    userId,
    userId,
    hasQuery ? 1 : 0,
    likeQuery,
    likeQuery,
    likeQuery,
    likeQuery
  );

  const seen = new Set<string>();
  const seenTitle = new Set<string>();
  return rows
    .map((row) => {
      const image = resolveGalleryImage({
        image: row.image,
        imageUrl: row.image_url,
        shotId: row.shot_id,
        imageId: row.image_id,
      });
      return {
        id: String(row.id),
        title: row.title,
        image,
        tag: row.tag,
        height: normalizeHeight(row.height),
        shotId: row.shot_id,
        titleHeader: row.title_header,
        imageId: row.image_id,
        imageUrl: normalizeRemoteImageUri(row.image_url) || image,
        paletteHex: parsePaletteJson(row.palette_json),
        details: parseDetailsJson(row.details_json),
        likesCount: Number(row.likes_count ?? 0),
        commentsCount: Number(row.comments_count ?? 0),
        likedByMe: Number(row.liked_by_me ?? 0) > 0,
        favoritedByMe: Number(row.favorited_by_me ?? 0) > 0,
      };
    })
    .filter((row) => !!row.image)
    .filter((row) => {
      const key = dedupeKey({
        imageId: row.imageId,
        shotId: row.shotId,
        title: row.title,
      });
      const tKey = titleKey(row.title);
      if (seen.has(key)) return false;
      if (seenTitle.has(tKey)) return false;
      seen.add(key);
      seenTitle.add(tKey);
      return true;
    });
}

export async function addGalleryItem(input: Omit<GalleryItem, 'id'>) {
  const remote = await requestBackendJson<{ item?: RemoteGalleryItem }>('/api/gallery', {
    method: 'POST',
    body: JSON.stringify({
      title: input.title,
      image: input.image,
      tag: input.tag,
      height: input.height,
      shot_id: input.shotId ?? null,
      title_header: input.titleHeader ?? null,
      image_id: input.imageId ?? null,
      image_url: input.imageUrl ?? null,
      palette_hex: input.paletteHex ?? [],
      details: input.details ?? {},
    }),
  });
  if (remote?.item) return;
  if (hasBackendApi()) return;

  const db = await getDb();
  const resolvedImage = resolveGalleryImage(input);
  if (!resolvedImage) {
    throw new Error('Image URL must be a public http(s) URL.');
  }
  await db.runAsync(
    `INSERT INTO gallery_items
     (title, image, tag, height, shot_id, title_header, image_id, image_url, palette_json, details_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    input.title.trim(),
    resolvedImage,
    input.tag.trim().toLowerCase(),
    normalizeHeight(input.height),
    input.shotId?.trim() || null,
    input.titleHeader?.trim() || null,
    input.imageId?.trim() || null,
    normalizeRemoteImageUri(input.imageUrl) || resolvedImage,
    JSON.stringify(input.paletteHex ?? []),
    JSON.stringify(input.details ?? {}),
    nowIso()
  );
}

export async function deleteGalleryItem(id: string) {
  const remote = await requestBackendJson<{ ok?: boolean }>(`/api/gallery/${encodeURIComponent(String(Number(id)))}`, {
    method: 'DELETE',
  });
  if (remote?.ok) return;
  if (hasBackendApi()) return;

  const db = await getDb();
  await db.runAsync('DELETE FROM gallery_items WHERE id = ?', Number(id));
}

export async function toggleGalleryLike(userId: number, galleryId: number) {
  const routeUserId = resolveUserRouteId(userId);
  if (hasBackendApi() && !routeUserId) return false;
  const remote = await requestBackendJson<{ active?: boolean }>(
    `/api/gallery/${galleryId}/toggle-like`,
    {
      method: 'POST',
      body: JSON.stringify({ user_id: routeUserId }),
    },
    routeUserId ? { userIdForToken: routeUserId } : undefined
  );
  if (typeof remote?.active === 'boolean') return remote.active;
  if (hasBackendApi()) return false;

  const db = await getDb();
  const exists = await db.getFirstAsync<{ ok: number }>(
    'SELECT 1 as ok FROM gallery_likes WHERE user_id = ? AND gallery_id = ?',
    userId,
    galleryId
  );
  if (exists) {
    await db.runAsync('DELETE FROM gallery_likes WHERE user_id = ? AND gallery_id = ?', userId, galleryId);
    return false;
  }
  await db.runAsync(
    'INSERT OR IGNORE INTO gallery_likes (gallery_id, user_id, created_at) VALUES (?, ?, ?)',
    galleryId,
    userId,
    nowIso()
  );
  return true;
}

export async function toggleGalleryFavorite(userId: number, galleryId: number) {
  const routeUserId = resolveUserRouteId(userId);
  if (hasBackendApi() && !routeUserId) return false;
  const remote = await requestBackendJson<{ active?: boolean }>(
    `/api/gallery/${galleryId}/toggle-favorite`,
    {
      method: 'POST',
      body: JSON.stringify({ user_id: routeUserId }),
    },
    routeUserId ? { userIdForToken: routeUserId } : undefined
  );
  if (typeof remote?.active === 'boolean') return remote.active;
  if (hasBackendApi()) return false;

  const db = await getDb();
  const exists = await db.getFirstAsync<{ ok: number }>(
    'SELECT 1 as ok FROM gallery_favorites WHERE user_id = ? AND gallery_id = ?',
    userId,
    galleryId
  );
  if (exists) {
    await db.runAsync('DELETE FROM gallery_favorites WHERE user_id = ? AND gallery_id = ?', userId, galleryId);
    return false;
  }
  await db.runAsync(
    'INSERT OR IGNORE INTO gallery_favorites (gallery_id, user_id, created_at) VALUES (?, ?, ?)',
    galleryId,
    userId,
    nowIso()
  );
  return true;
}

export async function getGalleryComments(galleryId: number): Promise<GalleryComment[]> {
  const remote = await requestBackendJson<{ comments?: RemoteGalleryComment[] }>(`/api/gallery/${galleryId}/comments`);
  if (Array.isArray(remote?.comments)) {
    return remote.comments.map(mapRemoteGalleryComment);
  }
  if (hasBackendApi()) return [];

  const db = await getDb();
  const rows = await db.getAllAsync<{
    id: number;
    gallery_id: number;
    user_id: number;
    nickname: string | null;
    avatar_url: string | null;
    text: string;
    parent_id: number | null;
    created_at: string;
  }>(
    `
    SELECT gc.id, gc.gallery_id, gc.user_id, u.nickname, u.avatar_url, gc.text, gc.parent_id, gc.created_at
    FROM gallery_comments gc
    LEFT JOIN users u ON u.id = gc.user_id
    WHERE gc.gallery_id = ?
    ORDER BY datetime(gc.created_at) ASC
    `,
    galleryId
  );
  return rows.map((row) => ({
    id: row.id,
    galleryId: row.gallery_id,
    userId: row.user_id,
    nickname: row.nickname || `user_${row.user_id}`,
    avatarUrl: row.avatar_url ?? null,
    text: row.text,
    parentId: row.parent_id ?? null,
    createdAt: row.created_at,
  }));
}

export async function addGalleryComment(userId: number, galleryId: number, text: string, parentId?: number | null) {
  const routeUserId = resolveUserRouteId(userId);
  if (hasBackendApi() && !routeUserId) return;
  const remote = await requestBackendJson<{ comment?: RemoteGalleryComment }>(
    `/api/gallery/${galleryId}/comments`,
    {
      method: 'POST',
      body: JSON.stringify({
        user_id: routeUserId,
        gallery_id: galleryId,
        text,
        parent_id: parentId ?? null,
      }),
    },
    routeUserId ? { userIdForToken: routeUserId } : undefined
  );
  if (remote?.comment) return;
  if (hasBackendApi()) return;

  const db = await getDb();
  const clean = text.trim();
  if (!clean) throw new Error('Comment is empty.');
  await db.runAsync(
    'INSERT INTO gallery_comments (gallery_id, user_id, text, parent_id, created_at) VALUES (?, ?, ?, ?, ?)',
    galleryId,
    userId,
    clean.slice(0, 1000),
    parentId ?? null,
    nowIso()
  );
}

export async function syncGalleryCommentAvatarsForUser(_userId: number, _avatarUrl: string | null) {
  // Native/SQLite comments resolve avatar from users table via JOIN, so no backfill is needed.
}

export async function getUserFavoriteGallery(userId: number): Promise<GalleryItem[]> {
  const routeUserId = resolveUserRouteId(userId);
  if (hasBackendApi() && !routeUserId) return [];
  const remote = await requestBackendJson<{ items?: RemoteGalleryItem[] }>(
    `/api/users/${encodeURIComponent(String(routeUserId))}/gallery-favorites`,
    undefined,
    routeUserId ? { userIdForToken: routeUserId } : undefined
  );
  if (Array.isArray(remote?.items)) {
    return dedupeMappedGalleryRows(remote.items.map(mapRemoteGalleryItem));
  }
  if (hasBackendApi()) return [];

  const db = await getDb();
  const rows = await db.getAllAsync<{
    id: number;
    title: string;
    image: string;
    tag: string;
    height: number;
    shot_id: string | null;
    title_header: string | null;
    image_id: string | null;
    image_url: string | null;
    palette_json: string | null;
    details_json: string | null;
  }>(
    `
    SELECT gi.id, gi.title, gi.image, gi.tag, gi.height, gi.shot_id, gi.title_header, gi.image_id, gi.image_url, gi.palette_json, gi.details_json
    FROM gallery_favorites gf
    INNER JOIN gallery_items gi ON gi.id = gf.gallery_id
    WHERE gf.user_id = ?
    ORDER BY datetime(gf.created_at) DESC
    `,
    userId
  );
  return rows.map((row) => ({
    id: String(row.id),
    title: row.title,
    image: resolveGalleryImage({
      image: row.image,
      imageUrl: row.image_url,
      shotId: row.shot_id,
      imageId: row.image_id,
    }),
    tag: row.tag,
    height: normalizeHeight(row.height),
    shotId: row.shot_id,
    titleHeader: row.title_header,
    imageId: row.image_id,
    imageUrl: normalizeRemoteImageUri(row.image_url) || resolveGalleryImage({
      image: row.image,
      imageUrl: row.image_url,
      shotId: row.shot_id,
      imageId: row.image_id,
    }),
    paletteHex: parsePaletteJson(row.palette_json),
    details: parseDetailsJson(row.details_json),
  }));
}

export async function clearGalleryAll() {
  let remoteError: Error | null = null;
  if (hasBackendApi()) {
    const remoteList = await requestBackendJson<{ items?: RemoteGalleryItem[] }>('/api/gallery');
    if (!Array.isArray(remoteList?.items)) {
      remoteError = new Error('Remote gallery list failed.');
    } else {
      const failedIds: Array<string | number> = [];
      for (const item of remoteList.items) {
        const itemId = Number(item.id);
        if (!Number.isFinite(itemId) || itemId <= 0) {
          failedIds.push(String(item.id));
          continue;
        }
        const remoteDelete = await requestBackendJson<{ ok?: boolean }>(
          `/api/gallery/${encodeURIComponent(String(itemId))}`,
          { method: 'DELETE' }
        );
        if (!remoteDelete?.ok) {
          failedIds.push(item.id);
        }
      }
      if (failedIds.length > 0) {
        remoteError = new Error(`Remote gallery delete failed for id(s): ${failedIds.join(', ')}`);
      }
    }
  }

  const db = await getDb();
  await db.execAsync(`
    DELETE FROM gallery_comments;
    DELETE FROM gallery_likes;
    DELETE FROM gallery_favorites;
    DELETE FROM gallery_items;
  `);
  await setGallerySeedDisabledNative(true);
  ensureSeededOncePromise = null;
  if (remoteError) throw remoteError;
}

export async function restoreGallerySeed() {
  await setGallerySeedDisabledNative(false);
  ensureSeededOncePromise = null;
  await ensureSeededOnce();
}
