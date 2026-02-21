import { GALLERY_SEED } from '@/data/gallery-seed';
import { getBackendApiUrl, hasBackendApi } from '@/lib/cinema-backend';

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

type GalleryState = {
  items: GalleryItem[];
  likes: Array<{ galleryId: number; userId: number; createdAt: string }>;
  favorites: Array<{ galleryId: number; userId: number; createdAt: string }>;
  comments: GalleryComment[];
  idSeq: number;
  commentIdSeq: number;
};

const STORAGE_KEY = 'movie_rec_gallery_items_v2';
const GALLERY_SEED_DISABLED_KEY = 'movie_rec_gallery_seed_disabled_v1';

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

async function requestBackendJson<T>(path: string, init?: RequestInit): Promise<T | null> {
  if (!hasBackendApi()) return null;
  const url = getBackendApiUrl(path);
  if (!url) return null;
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(init?.headers as Record<string, string> | undefined),
    };
    const res = await fetch(url, { ...init, headers });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
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

function normalizeAvatarUri(value: string | null | undefined) {
  const uri = String(value ?? '').trim();
  if (!uri) return null;
  if (uri.startsWith('http://') || uri.startsWith('https://') || uri.startsWith('data:image/') || uri.startsWith('blob:')) {
    return uri;
  }
  return null;
}

function getAuthUsersMap() {
  try {
    const raw = localStorage.getItem('movie_rec_auth_state');
    if (!raw) return new Map<number, { nickname: string; avatar_url: string | null }>();
    const parsed = JSON.parse(raw) as { users?: Array<{ id: number; nickname: string; avatar_url?: string | null }> };
    const map = new Map<number, { nickname: string; avatar_url: string | null }>();
    for (const user of parsed.users ?? []) {
      const uid = Number(user.id);
      if (!Number.isFinite(uid) || uid <= 0) continue;
      map.set(uid, {
        nickname: String(user.nickname ?? '').trim() || `user_${uid}`,
        avatar_url: normalizeAvatarUri(user.avatar_url ?? null),
      });
    }
    return map;
  } catch {
    return new Map<number, { nickname: string; avatar_url: string | null }>();
  }
}

function normalizeHeight(value: unknown) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 240;
  return Math.max(160, Math.min(520, Math.round(parsed)));
}

function normalizeDetails(details: GalleryDetails | null | undefined): GalleryDetails {
  const out: GalleryDetails = {};
  for (const [key, value] of Object.entries(details ?? {})) {
    const cleanKey = String(key).trim();
    const cleanValue = String(value ?? '').trim();
    if (cleanKey && cleanValue) out[cleanKey] = cleanValue;
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
}

function normalizeWebImageUri(uri: string | null | undefined) {
  const clean = String(uri ?? '').trim();
  if (!clean) return '';
  if (clean.startsWith('http://') || clean.startsWith('https://') || clean.startsWith('data:image/') || clean.startsWith('blob:')) {
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
  const direct = normalizeWebImageUri(directRaw);
  if (direct && !isRestrictedShotdeckUrl(direct) && !isLegacyShotdeckPlaceholder(direct)) return direct;

  const urlRaw = String(item.imageUrl ?? '').trim();
  const url = normalizeWebImageUri(urlRaw);
  if (url && !isRestrictedShotdeckUrl(url) && !isLegacyShotdeckPlaceholder(url)) return url;

  const derivedShotdeck = deriveShotdeckUrl(item);
  if (isRestrictedShotdeckUrl(directRaw) || isRestrictedShotdeckUrl(urlRaw) || isRestrictedShotdeckUrl(derivedShotdeck)) {
    return fallbackGalleryImage(item);
  }

  const normalizedDerived = normalizeWebImageUri(derivedShotdeck);
  if (normalizedDerived) return normalizedDerived;
  return fallbackGalleryImage(item);
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
    height: normalizeHeight(row.height),
    tag: String(row.tag || 'gallery'),
    shotId: row.shot_id ?? null,
    titleHeader: row.title_header ?? null,
    imageId: row.image_id ?? null,
    imageUrl: normalizeWebImageUri(row.image_url) || image,
    paletteHex: Array.isArray(row.palette_hex)
      ? row.palette_hex.map((x) => String(x)).filter((x) => /^#[0-9a-fA-F]{6}$/.test(x))
      : [],
    details: normalizeDetails(row.details ?? {}),
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

function seedKey(item: { imageId?: string | null; shotId?: string | null; title: string }) {
  const imageId = String(item.imageId ?? '').trim().toLowerCase();
  const shotId = String(item.shotId ?? '').trim().toLowerCase();
  if (imageId || shotId) return `${imageId}::${shotId}`;
  return `title:${item.title.trim().toLowerCase()}`;
}

function mergeSeedItems(items: GalleryItem[]) {
  if (isSeedDisabled()) {
    return [...items];
  }
  const normalizedExisting = items.map((item) => {
    const resolvedImage = resolveGalleryImage(item);
    return {
      ...item,
      image: resolvedImage || item.image,
      imageUrl: normalizeWebImageUri(item.imageUrl) || (resolvedImage.startsWith('http') ? resolvedImage : item.imageUrl ?? null),
      details: normalizeDetails(item.details),
    };
  });
  const existing = new Set(normalizedExisting.map((x) => seedKey(x)));
  const next = [...normalizedExisting];
  let maxId = items.reduce((acc, item) => Math.max(acc, Number(item.id) || 0), 0);
  for (const seed of SEED_ITEMS) {
    const key = seedKey(seed);
    if (existing.has(key)) continue;
    const resolvedImage = resolveGalleryImage(seed);
    if (!resolvedImage) continue;
    maxId += 1;
    next.push({
      ...seed,
      id: String(maxId),
      image: resolvedImage,
      imageUrl: normalizeWebImageUri(seed.imageUrl) || (resolvedImage.startsWith('http') ? resolvedImage : null),
      height: normalizeHeight(seed.height),
      details: normalizeDetails(seed.details),
    });
    existing.add(key);
  }
  return next;
}

function loadState(): GalleryState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      const items = isSeedDisabled() ? [] : mergeSeedItems([]);
      return { items, likes: [], favorites: [], comments: [], idSeq: items.length + 1, commentIdSeq: 1 };
    }
    const parsed = JSON.parse(raw) as GalleryState;
    const mergedItems = mergeSeedItems(parsed.items ?? []);
    return {
      items: mergedItems,
      likes: parsed.likes ?? [],
      favorites: parsed.favorites ?? [],
      comments: parsed.comments ?? [],
      idSeq: parsed.idSeq ?? (mergedItems.length + 1),
      commentIdSeq: parsed.commentIdSeq ?? ((parsed.comments?.length ?? 0) + 1),
    };
  } catch {
    const items = isSeedDisabled() ? [] : mergeSeedItems([]);
    return { items, likes: [], favorites: [], comments: [], idSeq: items.length + 1, commentIdSeq: 1 };
  }
}

function saveState(state: GalleryState) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
  }
}

function isSeedDisabled() {
  try {
    return localStorage.getItem(GALLERY_SEED_DISABLED_KEY) === '1';
  } catch {
    return false;
  }
}

const state = loadState();

export async function getGalleryItems(opts?: { userId?: number; query?: string }): Promise<GalleryFeedItem[]> {
  if (hasBackendApi()) {
    const search = new URLSearchParams();
    if (Number(opts?.userId ?? 0) > 0) {
      search.set('user_id', String(Number(opts?.userId ?? 0)));
    }
    const query = String(opts?.query ?? '').trim();
    if (query) search.set('query', query);
    const payload = await requestBackendJson<{ items?: RemoteGalleryItem[] }>(
      `/api/gallery${search.toString() ? `?${search.toString()}` : ''}`
    );
    if (Array.isArray(payload?.items)) {
      const remoteItems = payload.items.map(mapRemoteGalleryFeedItem).filter((item) => !!item.image);
      if (remoteItems.length > 0) return remoteItems;
    }
  }

  const userId = Number(opts?.userId ?? 0);
  const query = String(opts?.query ?? '').trim().toLowerCase();
  const filtered = query
    ? state.items.filter((item) => {
        const detailsText = Object.entries(item.details ?? {})
          .map(([k, v]) => `${k} ${v}`)
          .join(' ')
          .toLowerCase();
        return (
          item.title.toLowerCase().includes(query) ||
          item.tag.toLowerCase().includes(query) ||
          String(item.titleHeader || '').toLowerCase().includes(query) ||
          detailsText.includes(query)
        );
      })
    : state.items;

  return filtered.map((item) => {
    const galleryId = Number(item.id);
    const likesCount = state.likes.filter((x) => x.galleryId === galleryId).length;
    const commentsCount = state.comments.filter((x) => x.galleryId === galleryId).length;
    const likedByMe = !!state.likes.find((x) => x.galleryId === galleryId && x.userId === userId);
    const favoritedByMe = !!state.favorites.find((x) => x.galleryId === galleryId && x.userId === userId);
    return {
      ...item,
      height: normalizeHeight(item.height),
      likesCount,
      commentsCount,
      likedByMe,
      favoritedByMe,
    };
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

  const next: GalleryItem = {
    id: String(state.idSeq++),
    title: input.title.trim(),
    image: input.image.trim(),
    tag: input.tag.trim().toLowerCase() || 'gallery',
    height: normalizeHeight(input.height),
    shotId: input.shotId?.trim() || null,
    titleHeader: input.titleHeader?.trim() || null,
    imageId: input.imageId?.trim() || null,
    imageUrl: input.imageUrl?.trim() || null,
    paletteHex: (input.paletteHex ?? []).map((x) => String(x)).filter((x) => /^#[0-9a-fA-F]{6}$/.test(x)),
    details: normalizeDetails(input.details),
  };
  state.items.unshift(next);
  saveState(state);
}

export async function deleteGalleryItem(id: string) {
  const remote = await requestBackendJson<{ ok?: boolean }>(`/api/gallery/${encodeURIComponent(String(Number(id)))}`, {
    method: 'DELETE',
  });
  if (remote?.ok) return;

  const galleryId = Number(id);
  state.items = state.items.filter((item) => item.id !== id);
  state.likes = state.likes.filter((x) => x.galleryId !== galleryId);
  state.favorites = state.favorites.filter((x) => x.galleryId !== galleryId);
  state.comments = state.comments.filter((x) => x.galleryId !== galleryId);
  saveState(state);
}

export async function toggleGalleryLike(userId: number, galleryId: number) {
  const remote = await requestBackendJson<{ active?: boolean }>(`/api/gallery/${galleryId}/toggle-like`, {
    method: 'POST',
    body: JSON.stringify({ user_id: userId }),
  });
  if (typeof remote?.active === 'boolean') return remote.active;

  const idx = state.likes.findIndex((x) => x.galleryId === galleryId && x.userId === userId);
  if (idx >= 0) {
    state.likes.splice(idx, 1);
    saveState(state);
    return false;
  }
  state.likes.push({ galleryId, userId, createdAt: nowIso() });
  saveState(state);
  return true;
}

export async function toggleGalleryFavorite(userId: number, galleryId: number) {
  const remote = await requestBackendJson<{ active?: boolean }>(`/api/gallery/${galleryId}/toggle-favorite`, {
    method: 'POST',
    body: JSON.stringify({ user_id: userId }),
  });
  if (typeof remote?.active === 'boolean') return remote.active;

  const idx = state.favorites.findIndex((x) => x.galleryId === galleryId && x.userId === userId);
  if (idx >= 0) {
    state.favorites.splice(idx, 1);
    saveState(state);
    return false;
  }
  state.favorites.push({ galleryId, userId, createdAt: nowIso() });
  saveState(state);
  return true;
}

export async function getGalleryComments(galleryId: number): Promise<GalleryComment[]> {
  const remote = await requestBackendJson<{ comments?: RemoteGalleryComment[] }>(`/api/gallery/${galleryId}/comments`);
  if (Array.isArray(remote?.comments)) {
    return remote.comments.map(mapRemoteGalleryComment);
  }

  const users = getAuthUsersMap();
  let changed = false;
  const list = state.comments
    .filter((x) => x.galleryId === galleryId)
    .map((comment) => {
      const user = users.get(comment.userId);
      if (!user) return comment;
      const nextNickname = comment.nickname?.trim() ? comment.nickname : user.nickname;
      const nextAvatar = user.avatar_url ?? null;
      if (nextNickname !== comment.nickname || nextAvatar !== comment.avatarUrl) {
        changed = true;
        return { ...comment, nickname: nextNickname, avatarUrl: nextAvatar };
      }
      return comment;
    })
    .sort((a, b) => (a.createdAt > b.createdAt ? 1 : -1));

  if (changed) {
    const byId = new Map(list.map((x) => [x.id, x]));
    state.comments = state.comments.map((x) => byId.get(x.id) ?? x);
    saveState(state);
  }

  return list;
}

export async function addGalleryComment(userId: number, galleryId: number, text: string, parentId?: number | null) {
  const remote = await requestBackendJson<{ comment?: RemoteGalleryComment }>(`/api/gallery/${galleryId}/comments`, {
    method: 'POST',
    body: JSON.stringify({
      user_id: userId,
      gallery_id: galleryId,
      text,
      parent_id: parentId ?? null,
    }),
  });
  if (remote?.comment) return;

  const clean = text.trim();
  if (!clean) throw new Error('Comment is empty.');
  const user = getAuthUsersMap().get(Number(userId));
  const nickname = user?.nickname || `user_${userId}`;
  const avatarUrl = user?.avatar_url ?? null;
  state.comments.push({
    id: state.commentIdSeq++,
    galleryId,
    userId,
    nickname,
    avatarUrl,
    text: clean.slice(0, 1000),
    parentId: parentId ?? null,
    createdAt: nowIso(),
  });
  saveState(state);
}

export async function syncGalleryCommentAvatarsForUser(userId: number, avatarUrl: string | null) {
  const normalized = normalizeAvatarUri(avatarUrl);
  let changed = false;
  state.comments = state.comments.map((comment) => {
    if (Number(comment.userId) !== Number(userId)) return comment;
    if ((comment.avatarUrl ?? null) === normalized) return comment;
    changed = true;
    return { ...comment, avatarUrl: normalized };
  });
  if (changed) saveState(state);
}

export async function getUserFavoriteGallery(userId: number): Promise<GalleryItem[]> {
  const remote = await requestBackendJson<{ items?: RemoteGalleryItem[] }>(
    `/api/users/${encodeURIComponent(String(userId))}/gallery-favorites`
  );
  if (Array.isArray(remote?.items)) {
    return remote.items.map(mapRemoteGalleryItem);
  }

  const ids = new Set(state.favorites.filter((x) => x.userId === userId).map((x) => x.galleryId));
  return state.items.filter((item) => ids.has(Number(item.id)));
}

export async function clearGalleryAll() {
  if (hasBackendApi()) {
    const remoteList = await requestBackendJson<{ items?: RemoteGalleryItem[] }>('/api/gallery');
    if (!Array.isArray(remoteList?.items)) {
      throw new Error('Remote gallery list failed.');
    }
    for (const item of remoteList.items) {
      const remoteDelete = await requestBackendJson<{ ok?: boolean }>(
        `/api/gallery/${encodeURIComponent(String(Number(item.id)))}`,
        { method: 'DELETE' }
      );
      if (!remoteDelete?.ok) {
        throw new Error(`Remote gallery delete failed for id ${item.id}.`);
      }
    }
  }

  try {
    localStorage.setItem(GALLERY_SEED_DISABLED_KEY, '1');
  } catch {
  }
  state.items = [];
  state.likes = [];
  state.favorites = [];
  state.comments = [];
  state.idSeq = 1;
  state.commentIdSeq = 1;
  saveState(state);
}

export async function restoreGallerySeed() {
  try {
    localStorage.removeItem(GALLERY_SEED_DISABLED_KEY);
  } catch {
  }
  state.items = mergeSeedItems(state.items);
  const maxId = state.items.reduce((acc, item) => Math.max(acc, Number(item.id) || 0), 0);
  state.idSeq = Math.max(state.idSeq, maxId + 1);
  saveState(state);
}
