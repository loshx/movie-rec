import { getDb } from './database';

function nowIso() {
  return new Date().toISOString();
}

export type AppNotification = {
  id: number;
  userId: number;
  type: string;
  title: string;
  body: string;
  actionPath: string | null;
  payload: Record<string, unknown> | null;
  dedupeKey: string | null;
  createdAt: string;
  readAt: string | null;
};

export type NotificationInput = {
  type: string;
  title: string;
  body: string;
  actionPath?: string | null;
  payload?: Record<string, unknown> | null;
  dedupeKey?: string | null;
};

export type NotificationSubscription = {
  userId: number;
  kind: string;
  targetId: string;
  payload: Record<string, unknown> | null;
  createdAt: string;
};

export type NotificationReplyCandidate = {
  source: 'movie' | 'gallery';
  replyId: number;
  parentId: number;
  createdAt: string;
  text: string;
  fromUserId: number;
  fromNickname: string;
  fromAvatarUrl: string | null;
  tmdbId: number | null;
  galleryId: number | null;
};

function parsePayload(raw: string | null | undefined) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function mapNotificationRow(row: {
  id: number;
  user_id: number;
  type: string;
  title: string;
  body: string;
  action_path: string | null;
  payload_json: string | null;
  dedupe_key: string | null;
  created_at: string;
  read_at: string | null;
}): AppNotification {
  return {
    id: Number(row.id),
    userId: Number(row.user_id),
    type: String(row.type || 'generic'),
    title: String(row.title || ''),
    body: String(row.body || ''),
    actionPath: row.action_path ?? null,
    payload: parsePayload(row.payload_json),
    dedupeKey: row.dedupe_key ?? null,
    createdAt: String(row.created_at || nowIso()),
    readAt: row.read_at ?? null,
  };
}

export async function addUserNotification(userId: number, input: NotificationInput) {
  const db = await getDb();
  const cleanUserId = Number(userId);
  if (!Number.isFinite(cleanUserId) || cleanUserId <= 0) return null;

  const cleanType = String(input.type || 'generic').trim() || 'generic';
  const cleanTitle = String(input.title || '').trim();
  const cleanBody = String(input.body || '').trim();
  if (!cleanTitle || !cleanBody) return null;

  const cleanActionPath = String(input.actionPath ?? '').trim() || null;
  const cleanDedupeKey = String(input.dedupeKey ?? '').trim() || null;
  const payloadJson = input.payload ? JSON.stringify(input.payload) : null;
  const createdAt = nowIso();

  try {
    await db.runAsync(
      `
      INSERT INTO user_notifications
        (user_id, type, title, body, action_path, payload_json, dedupe_key, created_at, read_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
      `,
      cleanUserId,
      cleanType,
      cleanTitle,
      cleanBody,
      cleanActionPath,
      payloadJson,
      cleanDedupeKey,
      createdAt
    );
  } catch {
    // Most likely dedupe conflict.
    return null;
  }

  const row = await db.getFirstAsync<{
    id: number;
    user_id: number;
    type: string;
    title: string;
    body: string;
    action_path: string | null;
    payload_json: string | null;
    dedupe_key: string | null;
    created_at: string;
    read_at: string | null;
  }>(
    `
    SELECT id, user_id, type, title, body, action_path, payload_json, dedupe_key, created_at, read_at
    FROM user_notifications
    WHERE user_id = ?
    ORDER BY id DESC
    LIMIT 1
    `,
    cleanUserId
  );

  return row ? mapNotificationRow(row) : null;
}

export async function listUserNotifications(userId: number, limit = 120): Promise<AppNotification[]> {
  const db = await getDb();
  const cleanUserId = Number(userId);
  if (!Number.isFinite(cleanUserId) || cleanUserId <= 0) return [];
  const cleanLimit = Math.max(1, Math.min(500, Math.floor(limit)));

  const rows = await db.getAllAsync<{
    id: number;
    user_id: number;
    type: string;
    title: string;
    body: string;
    action_path: string | null;
    payload_json: string | null;
    dedupe_key: string | null;
    created_at: string;
    read_at: string | null;
  }>(
    `
    SELECT id, user_id, type, title, body, action_path, payload_json, dedupe_key, created_at, read_at
    FROM user_notifications
    WHERE user_id = ?
    ORDER BY datetime(created_at) DESC, id DESC
    LIMIT ?
    `,
    cleanUserId,
    cleanLimit
  );

  return rows.map(mapNotificationRow);
}

export async function getUnreadNotificationCount(userId: number) {
  const db = await getDb();
  const cleanUserId = Number(userId);
  if (!Number.isFinite(cleanUserId) || cleanUserId <= 0) return 0;
  const row = await db.getFirstAsync<{ c: number }>(
    'SELECT COUNT(*) as c FROM user_notifications WHERE user_id = ? AND read_at IS NULL',
    cleanUserId
  );
  return Number(row?.c ?? 0);
}

export async function markNotificationRead(userId: number, notificationId: number) {
  const db = await getDb();
  const cleanUserId = Number(userId);
  const cleanNotificationId = Number(notificationId);
  if (!Number.isFinite(cleanUserId) || cleanUserId <= 0) return;
  if (!Number.isFinite(cleanNotificationId) || cleanNotificationId <= 0) return;
  await db.runAsync(
    `
    UPDATE user_notifications
    SET read_at = COALESCE(read_at, ?)
    WHERE user_id = ? AND id = ?
    `,
    nowIso(),
    cleanUserId,
    cleanNotificationId
  );
}

export async function markAllNotificationsRead(userId: number) {
  const db = await getDb();
  const cleanUserId = Number(userId);
  if (!Number.isFinite(cleanUserId) || cleanUserId <= 0) return;
  await db.runAsync(
    `
    UPDATE user_notifications
    SET read_at = COALESCE(read_at, ?)
    WHERE user_id = ? AND read_at IS NULL
    `,
    nowIso(),
    cleanUserId
  );
}

export async function hasNotificationMarker(userId: number, scope: string, marker: string) {
  const db = await getDb();
  const cleanUserId = Number(userId);
  const cleanScope = String(scope || '').trim();
  const cleanMarker = String(marker || '').trim();
  if (!Number.isFinite(cleanUserId) || cleanUserId <= 0) return false;
  if (!cleanScope || !cleanMarker) return false;

  const row = await db.getFirstAsync<{ ok: number }>(
    'SELECT 1 as ok FROM notification_markers WHERE user_id = ? AND scope = ? AND marker = ?',
    cleanUserId,
    cleanScope,
    cleanMarker
  );
  return !!row;
}

export async function setNotificationMarker(userId: number, scope: string, marker: string) {
  const db = await getDb();
  const cleanUserId = Number(userId);
  const cleanScope = String(scope || '').trim();
  const cleanMarker = String(marker || '').trim();
  if (!Number.isFinite(cleanUserId) || cleanUserId <= 0) return;
  if (!cleanScope || !cleanMarker) return;

  await db.runAsync(
    `
    INSERT OR IGNORE INTO notification_markers (user_id, scope, marker, created_at)
    VALUES (?, ?, ?, ?)
    `,
    cleanUserId,
    cleanScope,
    cleanMarker,
    nowIso()
  );
}

export async function upsertNotificationSubscription(
  userId: number,
  kind: string,
  targetId: string,
  payload?: Record<string, unknown> | null
) {
  const db = await getDb();
  const cleanUserId = Number(userId);
  const cleanKind = String(kind || '').trim();
  const cleanTargetId = String(targetId || '').trim();
  if (!Number.isFinite(cleanUserId) || cleanUserId <= 0) return;
  if (!cleanKind || !cleanTargetId) return;

  await db.runAsync(
    `
    INSERT INTO notification_subscriptions (user_id, kind, target_id, payload_json, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id, kind, target_id)
    DO UPDATE SET payload_json = excluded.payload_json, created_at = excluded.created_at
    `,
    cleanUserId,
    cleanKind,
    cleanTargetId,
    payload ? JSON.stringify(payload) : null,
    nowIso()
  );
}

export async function removeNotificationSubscription(userId: number, kind: string, targetId: string) {
  const db = await getDb();
  const cleanUserId = Number(userId);
  const cleanKind = String(kind || '').trim();
  const cleanTargetId = String(targetId || '').trim();
  if (!Number.isFinite(cleanUserId) || cleanUserId <= 0) return;
  if (!cleanKind || !cleanTargetId) return;
  await db.runAsync(
    'DELETE FROM notification_subscriptions WHERE user_id = ? AND kind = ? AND target_id = ?',
    cleanUserId,
    cleanKind,
    cleanTargetId
  );
}

export async function listNotificationSubscriptions(
  userId: number,
  kind?: string | null
): Promise<NotificationSubscription[]> {
  const db = await getDb();
  const cleanUserId = Number(userId);
  if (!Number.isFinite(cleanUserId) || cleanUserId <= 0) return [];
  const cleanKind = String(kind ?? '').trim();

  const rows = cleanKind
    ? await db.getAllAsync<{
        user_id: number;
        kind: string;
        target_id: string;
        payload_json: string | null;
        created_at: string;
      }>(
        `
        SELECT user_id, kind, target_id, payload_json, created_at
        FROM notification_subscriptions
        WHERE user_id = ? AND kind = ?
        ORDER BY datetime(created_at) DESC
        `,
        cleanUserId,
        cleanKind
      )
    : await db.getAllAsync<{
        user_id: number;
        kind: string;
        target_id: string;
        payload_json: string | null;
        created_at: string;
      }>(
        `
        SELECT user_id, kind, target_id, payload_json, created_at
        FROM notification_subscriptions
        WHERE user_id = ?
        ORDER BY datetime(created_at) DESC
        `,
        cleanUserId
      );

  return rows.map((row) => ({
    userId: Number(row.user_id),
    kind: String(row.kind || ''),
    targetId: String(row.target_id || ''),
    payload: parsePayload(row.payload_json),
    createdAt: String(row.created_at || nowIso()),
  }));
}

export async function listLocalReplyCandidates(
  userId: number,
  limit = 80
): Promise<NotificationReplyCandidate[]> {
  const db = await getDb();
  const cleanUserId = Number(userId);
  if (!Number.isFinite(cleanUserId) || cleanUserId <= 0) return [];
  const cleanLimit = Math.max(1, Math.min(300, Math.floor(limit)));

  const movieRows = await db.getAllAsync<{
    source: 'movie';
    reply_id: number;
    parent_id: number;
    created_at: string;
    text: string;
    from_user_id: number;
    from_nickname: string;
    from_avatar_url: string | null;
    tmdb_id: number;
    gallery_id: null;
  }>(
    `
    SELECT
      'movie' as source,
      child.id as reply_id,
      parent.id as parent_id,
      child.created_at as created_at,
      child.text as text,
      child.user_id as from_user_id,
      COALESCE(u.nickname, 'user') as from_nickname,
      u.avatar_url as from_avatar_url,
      child.tmdb_id as tmdb_id,
      NULL as gallery_id
    FROM user_comments child
    INNER JOIN user_comments parent ON parent.id = child.parent_id
    LEFT JOIN users u ON u.id = child.user_id
    WHERE parent.user_id = ?
      AND child.user_id != ?
    ORDER BY datetime(child.created_at) DESC, child.id DESC
    LIMIT ?
    `,
    cleanUserId,
    cleanUserId,
    cleanLimit
  );

  const galleryRows = await db.getAllAsync<{
    source: 'gallery';
    reply_id: number;
    parent_id: number;
    created_at: string;
    text: string;
    from_user_id: number;
    from_nickname: string;
    from_avatar_url: string | null;
    tmdb_id: null;
    gallery_id: number;
  }>(
    `
    SELECT
      'gallery' as source,
      child.id as reply_id,
      parent.id as parent_id,
      child.created_at as created_at,
      child.text as text,
      child.user_id as from_user_id,
      COALESCE(u.nickname, 'user') as from_nickname,
      u.avatar_url as from_avatar_url,
      NULL as tmdb_id,
      child.gallery_id as gallery_id
    FROM gallery_comments child
    INNER JOIN gallery_comments parent ON parent.id = child.parent_id
    LEFT JOIN users u ON u.id = child.user_id
    WHERE parent.user_id = ?
      AND child.user_id != ?
    ORDER BY datetime(child.created_at) DESC, child.id DESC
    LIMIT ?
    `,
    cleanUserId,
    cleanUserId,
    cleanLimit
  );

  return [...movieRows, ...galleryRows]
    .map((row) => ({
      source: row.source,
      replyId: Number(row.reply_id),
      parentId: Number(row.parent_id),
      createdAt: String(row.created_at || nowIso()),
      text: String(row.text || ''),
      fromUserId: Number(row.from_user_id),
      fromNickname: String(row.from_nickname || 'user'),
      fromAvatarUrl: row.from_avatar_url ?? null,
      tmdbId: Number.isFinite(Number(row.tmdb_id)) ? Number(row.tmdb_id) : null,
      galleryId: Number.isFinite(Number(row.gallery_id)) ? Number(row.gallery_id) : null,
    }))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, cleanLimit);
}
