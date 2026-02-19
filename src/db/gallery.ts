import { getDb } from './database';
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

const SEED_ITEMS: Array<Omit<GalleryItem, 'id'>> = GALLERY_SEED;

function nowIso() {
  return new Date().toISOString();
}

function normalizeHeight(value: unknown) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 240;
  return Math.max(160, Math.min(520, Math.round(parsed)));
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

async function ensureSeeded() {
  const db = await getDb();
  for (const item of SEED_ITEMS) {
    const existing = await db.getFirstAsync<{ id: number }>(
      `
      SELECT id
      FROM gallery_items
      WHERE
        (COALESCE(image_id, '') != '' AND image_id = ?)
        OR (COALESCE(shot_id, '') != '' AND shot_id = ?)
        OR (
          COALESCE(image_id, '') = ''
          AND COALESCE(shot_id, '') = ''
          AND image = ?
        )
      LIMIT 1
      `,
      item.imageId ?? '',
      item.shotId ?? '',
      item.image
    );
    if (existing) continue;

    await db.runAsync(
      `INSERT INTO gallery_items
       (title, image, tag, height, shot_id, title_header, image_id, image_url, palette_json, details_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      item.title,
      item.image,
      item.tag,
      normalizeHeight(item.height),
      item.shotId ?? null,
      item.titleHeader ?? null,
      item.imageId ?? null,
      item.imageUrl ?? null,
      JSON.stringify(item.paletteHex ?? []),
      JSON.stringify(item.details ?? {}),
      nowIso()
    );
  }
}

export async function getGalleryItems(opts?: { userId?: number; query?: string }): Promise<GalleryFeedItem[]> {
  await ensureSeeded();
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

  return rows.map((row) => ({
    id: String(row.id),
    title: row.title,
    image: row.image,
    tag: row.tag,
    height: normalizeHeight(row.height),
    shotId: row.shot_id,
    titleHeader: row.title_header,
    imageId: row.image_id,
    imageUrl: row.image_url,
    paletteHex: parsePaletteJson(row.palette_json),
    details: parseDetailsJson(row.details_json),
    likesCount: Number(row.likes_count ?? 0),
    commentsCount: Number(row.comments_count ?? 0),
    likedByMe: Number(row.liked_by_me ?? 0) > 0,
    favoritedByMe: Number(row.favorited_by_me ?? 0) > 0,
  }));
}

export async function addGalleryItem(input: Omit<GalleryItem, 'id'>) {
  const db = await getDb();
  await db.runAsync(
    `INSERT INTO gallery_items
     (title, image, tag, height, shot_id, title_header, image_id, image_url, palette_json, details_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    input.title.trim(),
    input.image.trim(),
    input.tag.trim().toLowerCase(),
    normalizeHeight(input.height),
    input.shotId?.trim() || null,
    input.titleHeader?.trim() || null,
    input.imageId?.trim() || null,
    input.imageUrl?.trim() || null,
    JSON.stringify(input.paletteHex ?? []),
    JSON.stringify(input.details ?? {}),
    nowIso()
  );
}

export async function deleteGalleryItem(id: string) {
  const db = await getDb();
  await db.runAsync('DELETE FROM gallery_items WHERE id = ?', Number(id));
}

export async function toggleGalleryLike(userId: number, galleryId: number) {
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
    image: row.image,
    tag: row.tag,
    height: normalizeHeight(row.height),
    shotId: row.shot_id,
    titleHeader: row.title_header,
    imageId: row.image_id,
    imageUrl: row.image_url,
    paletteHex: parsePaletteJson(row.palette_json),
    details: parseDetailsJson(row.details_json),
  }));
}

export async function clearGalleryAll() {
  const db = await getDb();
  await db.execAsync(`
    DELETE FROM gallery_comments;
    DELETE FROM gallery_likes;
    DELETE FROM gallery_favorites;
    DELETE FROM gallery_items;
  `);
}

export async function restoreGallerySeed() {
  await ensureSeeded();
}
