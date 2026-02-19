import { GALLERY_SEED } from '@/data/gallery-seed';

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
}) {
  const direct = normalizeWebImageUri(item.image);
  if (direct) return direct;
  const url = normalizeWebImageUri(item.imageUrl);
  if (url) return url;
  const shotdeck = deriveShotdeckUrl(item);
  if (shotdeck) return shotdeck;
  return '';
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
  const galleryId = Number(id);
  state.items = state.items.filter((item) => item.id !== id);
  state.likes = state.likes.filter((x) => x.galleryId !== galleryId);
  state.favorites = state.favorites.filter((x) => x.galleryId !== galleryId);
  state.comments = state.comments.filter((x) => x.galleryId !== galleryId);
  saveState(state);
}

export async function toggleGalleryLike(userId: number, galleryId: number) {
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
  const ids = new Set(state.favorites.filter((x) => x.userId === userId).map((x) => x.galleryId));
  return state.items.filter((item) => ids.has(Number(item.id)));
}

export async function clearGalleryAll() {
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
