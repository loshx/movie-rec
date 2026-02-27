type AppNotificationRow = {
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

type MarkerRow = {
  userId: number;
  scope: string;
  marker: string;
};

type SubscriptionRow = {
  userId: number;
  kind: string;
  targetId: string;
  payload: Record<string, unknown> | null;
  createdAt: string;
};

const rows: AppNotificationRow[] = [];
const markers: MarkerRow[] = [];
const subscriptions: SubscriptionRow[] = [];
let nextId = 1;

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

export async function addUserNotification(userId: number, input: NotificationInput) {
  const cleanUserId = Number(userId);
  if (!Number.isFinite(cleanUserId) || cleanUserId <= 0) return null;
  const title = String(input.title || '').trim();
  const body = String(input.body || '').trim();
  if (!title || !body) return null;
  const dedupeKey = String(input.dedupeKey ?? '').trim() || null;
  if (dedupeKey && rows.some((row) => row.userId === cleanUserId && row.dedupeKey === dedupeKey)) {
    return null;
  }
  const row: AppNotificationRow = {
    id: nextId++,
    userId: cleanUserId,
    type: String(input.type || 'generic').trim() || 'generic',
    title,
    body,
    actionPath: String(input.actionPath ?? '').trim() || null,
    payload: input.payload ?? null,
    dedupeKey,
    createdAt: nowIso(),
    readAt: null,
  };
  rows.push(row);
  return { ...row };
}

export async function listUserNotifications(userId: number, limit = 120): Promise<AppNotification[]> {
  const cleanUserId = Number(userId);
  if (!Number.isFinite(cleanUserId) || cleanUserId <= 0) return [];
  const cleanLimit = Math.max(1, Math.min(500, Math.floor(limit)));
  return rows
    .filter((row) => row.userId === cleanUserId)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.id - a.id)
    .slice(0, cleanLimit)
    .map((row) => ({ ...row }));
}

export async function getUnreadNotificationCount(userId: number) {
  const cleanUserId = Number(userId);
  if (!Number.isFinite(cleanUserId) || cleanUserId <= 0) return 0;
  return rows.filter((row) => row.userId === cleanUserId && !row.readAt).length;
}

export async function markNotificationRead(userId: number, notificationId: number) {
  const cleanUserId = Number(userId);
  const cleanNotificationId = Number(notificationId);
  if (!Number.isFinite(cleanUserId) || cleanUserId <= 0) return;
  if (!Number.isFinite(cleanNotificationId) || cleanNotificationId <= 0) return;
  const row = rows.find((item) => item.userId === cleanUserId && item.id === cleanNotificationId);
  if (!row) return;
  row.readAt = row.readAt || nowIso();
}

export async function markAllNotificationsRead(userId: number) {
  const cleanUserId = Number(userId);
  if (!Number.isFinite(cleanUserId) || cleanUserId <= 0) return;
  const now = nowIso();
  for (const row of rows) {
    if (row.userId === cleanUserId && !row.readAt) {
      row.readAt = now;
    }
  }
}

export async function hasNotificationMarker(userId: number, scope: string, marker: string) {
  const cleanUserId = Number(userId);
  const cleanScope = String(scope || '').trim();
  const cleanMarker = String(marker || '').trim();
  if (!Number.isFinite(cleanUserId) || cleanUserId <= 0) return false;
  if (!cleanScope || !cleanMarker) return false;
  return markers.some(
    (row) => row.userId === cleanUserId && row.scope === cleanScope && row.marker === cleanMarker
  );
}

export async function setNotificationMarker(userId: number, scope: string, marker: string) {
  const cleanUserId = Number(userId);
  const cleanScope = String(scope || '').trim();
  const cleanMarker = String(marker || '').trim();
  if (!Number.isFinite(cleanUserId) || cleanUserId <= 0) return;
  if (!cleanScope || !cleanMarker) return;
  if (
    markers.some(
      (row) => row.userId === cleanUserId && row.scope === cleanScope && row.marker === cleanMarker
    )
  ) {
    return;
  }
  markers.push({ userId: cleanUserId, scope: cleanScope, marker: cleanMarker });
}

export async function upsertNotificationSubscription(
  userId: number,
  kind: string,
  targetId: string,
  payload?: Record<string, unknown> | null
) {
  const cleanUserId = Number(userId);
  const cleanKind = String(kind || '').trim();
  const cleanTargetId = String(targetId || '').trim();
  if (!Number.isFinite(cleanUserId) || cleanUserId <= 0) return;
  if (!cleanKind || !cleanTargetId) return;
  const existing = subscriptions.find(
    (row) => row.userId === cleanUserId && row.kind === cleanKind && row.targetId === cleanTargetId
  );
  const createdAt = nowIso();
  if (existing) {
    existing.payload = payload ?? null;
    existing.createdAt = createdAt;
    return;
  }
  subscriptions.push({
    userId: cleanUserId,
    kind: cleanKind,
    targetId: cleanTargetId,
    payload: payload ?? null,
    createdAt,
  });
}

export async function removeNotificationSubscription(userId: number, kind: string, targetId: string) {
  const cleanUserId = Number(userId);
  const cleanKind = String(kind || '').trim();
  const cleanTargetId = String(targetId || '').trim();
  if (!Number.isFinite(cleanUserId) || cleanUserId <= 0) return;
  if (!cleanKind || !cleanTargetId) return;
  const idx = subscriptions.findIndex(
    (row) => row.userId === cleanUserId && row.kind === cleanKind && row.targetId === cleanTargetId
  );
  if (idx >= 0) subscriptions.splice(idx, 1);
}

export async function listNotificationSubscriptions(
  userId: number,
  kind?: string | null
): Promise<NotificationSubscription[]> {
  const cleanUserId = Number(userId);
  if (!Number.isFinite(cleanUserId) || cleanUserId <= 0) return [];
  const cleanKind = String(kind ?? '').trim();
  return subscriptions
    .filter((row) => row.userId === cleanUserId && (!cleanKind || row.kind === cleanKind))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .map((row) => ({ ...row }));
}

export async function listLocalReplyCandidates(
  _userId: number,
  _limit = 80
): Promise<NotificationReplyCandidate[]> {
  return [];
}

