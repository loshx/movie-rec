/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const WsLib = require('ws');
const WsServerCtor = WsLib.WebSocketServer || WsLib.Server;

const port = Number(process.env.CINEMA_API_PORT || process.env.CINEMA_WS_PORT || 8787);
const adminApiKey = String(process.env.ADMIN_API_KEY || '').trim();
const cloudinaryCloudName = String(process.env.CLOUDINARY_CLOUD_NAME || '').trim();
const cloudinaryApiKey = String(process.env.CLOUDINARY_API_KEY || '').trim();
const cloudinaryApiSecret = String(process.env.CLOUDINARY_API_SECRET || '').trim();

const dataDir = path.join(__dirname, 'data');
const dataFile = path.join(dataDir, 'cinema-events.json');

function ensureStore() {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(dataFile)) {
    fs.writeFileSync(dataFile, JSON.stringify({ idSeq: 1, items: [] }, null, 2), 'utf8');
  }
}

function loadStore() {
  ensureStore();
  try {
    const parsed = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    return {
      idSeq: Number(parsed?.idSeq || 1),
      items: Array.isArray(parsed?.items) ? parsed.items : [],
      commentIdSeq: Number(parsed?.commentIdSeq || 1),
      comments: Array.isArray(parsed?.comments) ? parsed.comments : [],
      users: parsed?.users && typeof parsed.users === 'object' ? parsed.users : {},
      follows: parsed?.follows && typeof parsed.follows === 'object' ? parsed.follows : {},
    };
  } catch {
    return { idSeq: 1, items: [], commentIdSeq: 1, comments: [], users: {}, follows: {} };
  }
}

function saveStore(store) {
  ensureStore();
  fs.writeFileSync(dataFile, JSON.stringify(store, null, 2), 'utf8');
}

const store = loadStore();

function nowIso() {
  return new Date().toISOString();
}

function normalizeAvatarUrl(input) {
  const value = input ? String(input).trim() : '';
  if (!value) return null;
  if (/^data:image\/[a-zA-Z0-9.+-]+;base64,/i.test(value)) {
    return value.length <= 2_000_000 ? value : null;
  }
  if (/^(https?:\/\/|blob:|file:\/\/|content:\/\/|ph:\/\/)/i.test(value)) {
    return value.slice(0, 2000);
  }
  return null;
}

function json(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
    'access-control-allow-headers': 'content-type,x-admin-key',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 2_000_000) {
        reject(new Error('Payload too large.'));
      }
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('Invalid JSON.'));
      }
    });
    req.on('error', reject);
  });
}

function getLatestEvent() {
  const items = [...store.items].sort((a, b) => Date.parse(b.start_at) - Date.parse(a.start_at));
  return items[0] ?? null;
}

function getCurrentEvent(nowIsoValue = nowIso()) {
  const now = Date.parse(nowIsoValue);
  const live = [...store.items]
    .filter((item) => Date.parse(item.start_at) <= now && Date.parse(item.end_at) >= now)
    .sort((a, b) => Date.parse(b.start_at) - Date.parse(a.start_at))[0];
  if (live) return live;

  const upcoming = [...store.items]
    .filter((item) => Date.parse(item.start_at) > now)
    .sort((a, b) => Date.parse(a.start_at) - Date.parse(b.start_at))[0];
  if (upcoming) return upcoming;

  return getLatestEvent();
}

function normalizeProfileSync(body) {
  const userId = Number(body?.user_id);
  if (!Number.isFinite(userId) || userId <= 0) throw new Error('user_id is required.');
  const nickname = String(body?.nickname || '').trim();
  if (!nickname) throw new Error('nickname is required.');
  const profile = {
    user_id: userId,
    nickname,
    name: body?.name ? String(body.name).trim() : null,
    bio: body?.bio ? String(body.bio).trim() : null,
    avatar_url: normalizeAvatarUrl(body?.avatar_url),
    privacy: {
      watchlist: !!body?.privacy?.watchlist,
      favorites: !!body?.privacy?.favorites,
      watched: !!body?.privacy?.watched,
      rated: !!body?.privacy?.rated,
      favorite_actors: !!body?.privacy?.favorite_actors,
      favorite_directors: !!body?.privacy?.favorite_directors,
    },
    watchlist: Array.isArray(body?.watchlist) ? body.watchlist.slice(0, 100) : [],
    favorites: Array.isArray(body?.favorites) ? body.favorites.slice(0, 100) : [],
    watched: Array.isArray(body?.watched) ? body.watched.slice(0, 120) : [],
    rated: Array.isArray(body?.rated) ? body.rated.slice(0, 120) : [],
    favorite_actors: Array.isArray(body?.favorite_actors) ? body.favorite_actors.slice(0, 80) : [],
    favorite_directors: Array.isArray(body?.favorite_directors) ? body.favorite_directors.slice(0, 80) : [],
    updated_at: nowIso(),
  };
  return profile;
}

function publicProfileView(userId) {
  const profile = store.users[String(userId)];
  if (!profile) return null;
  const followers = Object.values(store.follows).filter((setLike) => Array.isArray(setLike) && setLike.includes(userId)).length;
  const following = Array.isArray(store.follows[String(userId)]) ? store.follows[String(userId)].length : 0;
  return {
    user_id: profile.user_id,
    nickname: profile.nickname,
    name: profile.name,
    bio: profile.bio,
    avatar_url: normalizeAvatarUrl(profile.avatar_url),
    updated_at: profile.updated_at,
    followers,
    following,
    watchlist: profile.privacy.watchlist ? profile.watchlist : [],
    favorites: profile.privacy.favorites ? profile.favorites : [],
    watched: profile.privacy.watched ? profile.watched : [],
    rated: profile.privacy.rated ? profile.rated : [],
    favorite_actors: profile.privacy.favorite_actors ? profile.favorite_actors : [],
    favorite_directors: profile.privacy.favorite_directors ? profile.favorite_directors : [],
  };
}

function followUser(followerId, targetId) {
  if (followerId === targetId) throw new Error('Cannot follow yourself.');
  if (!store.users[String(targetId)]) throw new Error('Target user not found.');
  const key = String(followerId);
  const current = Array.isArray(store.follows[key]) ? store.follows[key] : [];
  if (!current.includes(targetId)) current.push(targetId);
  store.follows[key] = current;
}

function unfollowUser(followerId, targetId) {
  const key = String(followerId);
  const current = Array.isArray(store.follows[key]) ? store.follows[key] : [];
  store.follows[key] = current.filter((id) => id !== targetId);
}

function validateEventInput(input) {
  const title = String(input?.title || '').trim();
  const videoUrl = String(input?.video_url || '').trim();
  const posterUrl = String(input?.poster_url || '').trim();
  const tmdbIdRaw = Number(input?.tmdb_id);
  const tmdbId = Number.isFinite(tmdbIdRaw) && tmdbIdRaw > 0 ? Math.floor(tmdbIdRaw) : null;
  const startAt = String(input?.start_at || '').trim();
  const endAt = String(input?.end_at || '').trim();
  const description = input?.description ? String(input.description).trim() : null;
  const createdBy = Number.isFinite(Number(input?.created_by)) ? Number(input.created_by) : null;

  if (!title) throw new Error('Title is required.');
  if (!videoUrl) throw new Error('video_url is required.');
  if (!posterUrl) throw new Error('poster_url is required.');
  if (!/^https?:\/\//i.test(videoUrl)) throw new Error('video_url must be public URL.');
  if (!/^https?:\/\//i.test(posterUrl)) throw new Error('poster_url must be public URL.');
  if (!Number.isFinite(Date.parse(startAt))) throw new Error('Invalid start_at.');
  if (!Number.isFinite(Date.parse(endAt))) throw new Error('Invalid end_at.');
  if (Date.parse(endAt) <= Date.parse(startAt)) throw new Error('end_at must be after start_at.');

  return {
    title,
    description,
    video_url: videoUrl,
    poster_url: posterUrl,
    tmdb_id: tmdbId,
    start_at: startAt,
    end_at: endAt,
    created_by: createdBy,
  };
}

function normalizeCommentInput(input) {
  const userId = Number(input?.user_id);
  const tmdbId = Number(input?.tmdb_id);
  const text = String(input?.text || '').trim();
  const nickname = String(input?.nickname || 'user').trim().slice(0, 40) || 'user';
  const parentId = Number.isFinite(Number(input?.parent_id)) ? Number(input.parent_id) : null;
  const avatarUrl = normalizeAvatarUrl(input?.avatar_url);
  if (!Number.isFinite(userId) || userId <= 0) throw new Error('user_id is required.');
  if (!Number.isFinite(tmdbId) || tmdbId <= 0) throw new Error('tmdb_id is required.');
  if (!text) throw new Error('Comment text is required.');
  return {
    user_id: userId,
    tmdb_id: tmdbId,
    text: text.slice(0, 1000),
    nickname,
    parent_id: parentId,
    avatar_url: avatarUrl,
  };
}

function resolvePublicUserIdForNickname(nickname, fallbackUserId) {
  const clean = String(nickname || '').trim().toLowerCase();
  if (!clean) return fallbackUserId;
  const match = Object.values(store.users).find(
    (u) => String(u?.nickname || '').trim().toLowerCase() === clean
  );
  if (match && Number.isFinite(Number(match.user_id))) return Number(match.user_id);
  return fallbackUserId;
}

function isAuthorizedAdmin(req) {
  if (!adminApiKey) return true; // Dev fallback: if key missing, allow publish.
  const key = String(req.headers['x-admin-key'] || '').trim();
  return key && key === adminApiKey;
}

function extractCloudinaryPublicId(imageUrl) {
  const raw = String(imageUrl || '').trim();
  if (!raw) return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (!/cloudinary\.com$/i.test(parsed.hostname)) return null;
  if (!cloudinaryCloudName || !parsed.pathname.includes(`/${cloudinaryCloudName}/`)) return null;

  const segments = parsed.pathname.split('/').filter(Boolean);
  const uploadIdx = segments.findIndex((x) => x === 'upload');
  if (uploadIdx < 0) return null;

  const afterUpload = segments.slice(uploadIdx + 1);
  const withoutTransforms = [];
  let started = false;
  for (const part of afterUpload) {
    if (!started) {
      if (/^v\d+$/.test(part)) {
        started = true;
        continue;
      }
      if (part.includes(',') || part.includes('_')) {
        continue;
      }
      started = true;
    }
    withoutTransforms.push(part);
  }
  if (!withoutTransforms.length) return null;
  const last = withoutTransforms[withoutTransforms.length - 1];
  withoutTransforms[withoutTransforms.length - 1] = last.replace(/\.[a-zA-Z0-9]+$/, '');
  const publicId = withoutTransforms.join('/');
  return publicId || null;
}

function signCloudinaryDestroy(publicId, timestamp) {
  const payload = `public_id=${publicId}&timestamp=${timestamp}${cloudinaryApiSecret}`;
  return crypto.createHash('sha1').update(payload).digest('hex');
}

async function destroyCloudinaryAssetByUrl(assetUrl, resourceType = 'image') {
  if (!cloudinaryCloudName || !cloudinaryApiKey || !cloudinaryApiSecret) {
    throw new Error('Cloudinary server credentials are missing.');
  }
  const publicId = extractCloudinaryPublicId(assetUrl);
  if (!publicId) {
    throw new Error(`${resourceType}_url is not a valid Cloudinary URL.`);
  }
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = signCloudinaryDestroy(publicId, timestamp);
  const endpoint = `https://api.cloudinary.com/v1_1/${cloudinaryCloudName}/${resourceType}/destroy`;

  const form = new URLSearchParams();
  form.set('public_id', publicId);
  form.set('timestamp', String(timestamp));
  form.set('api_key', cloudinaryApiKey);
  form.set('signature', signature);
  form.set('invalidate', 'true');

  const res = await fetch(endpoint, {
    method: 'POST',
    body: form,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = data?.error?.message || 'Cloudinary destroy failed.';
    throw new Error(message);
  }
  if (!['ok', 'not found'].includes(String(data?.result || '').toLowerCase())) {
    throw new Error('Cloudinary destroy returned unexpected result.');
  }
}

async function destroyCloudinaryImageByUrl(imageUrl) {
  return destroyCloudinaryAssetByUrl(imageUrl, 'image');
}

async function destroyCloudinaryVideoByUrl(videoUrl) {
  return destroyCloudinaryAssetByUrl(videoUrl, 'video');
}

const EXPIRED_CLEANUP_INTERVAL_MS = 60_000;
let cleanupInProgress = false;
const expiredCleanupFailures = new Map();

async function cleanupExpiredCinemaEvents() {
  if (cleanupInProgress) return;
  cleanupInProgress = true;
  try {
    const now = Date.now();
    const expired = store.items.filter((item) => Number.isFinite(Date.parse(item?.end_at)) && Date.parse(item.end_at) < now);
    if (!expired.length) return;

    const kept = [];
    let removed = 0;

    for (const item of store.items) {
      const endAtMs = Date.parse(item?.end_at);
      const isExpired = Number.isFinite(endAtMs) && endAtMs < now;
      if (!isExpired) {
        kept.push(item);
        continue;
      }

      const videoUrl = String(item?.video_url || '').trim();
      const posterUrl = String(item?.poster_url || '').trim();
      try {
        if (videoUrl && extractCloudinaryPublicId(videoUrl)) {
          await destroyCloudinaryVideoByUrl(videoUrl);
        }
        if (posterUrl && extractCloudinaryPublicId(posterUrl)) {
          await destroyCloudinaryImageByUrl(posterUrl);
        }
        expiredCleanupFailures.delete(item.id);
        removed += 1;
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        const prev = expiredCleanupFailures.get(item.id);
        expiredCleanupFailures.set(item.id, {
          event_id: item.id,
          attempts: Number(prev?.attempts || 0) + 1,
          last_error: errorMessage,
          last_attempt_at: nowIso(),
          video_url: videoUrl || null,
          poster_url: posterUrl || null,
          end_at: item?.end_at || null,
        });
        console.error(
          `Failed expired cleanup for cinema event #${item?.id || '?'}. Keeping for retry:`,
          errorMessage
        );
        kept.push(item);
      }
    }

    if (removed > 0) {
      store.items = kept;
      saveStore(store);
      console.log(`Expired cinema cleanup removed ${removed} event(s).`);
    }
  } finally {
    cleanupInProgress = false;
  }
}

function resetAllStoreData() {
  store.idSeq = 1;
  store.items = [];
  store.commentIdSeq = 1;
  store.comments = [];
  store.users = {};
  store.follows = {};
  saveStore(store);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;
  const method = (req.method || 'GET').toUpperCase();

  if (method === 'OPTIONS') {
    return json(res, 200, { ok: true });
  }

  try {
    await cleanupExpiredCinemaEvents();

    if (method === 'GET' && pathname === '/health') {
      return json(res, 200, { ok: true, now: nowIso(), events: store.items.length });
    }

    if (method === 'GET' && pathname === '/api/cinema/latest') {
      return json(res, 200, { event: getLatestEvent() });
    }

    if (method === 'GET' && pathname === '/api/cinema/current') {
      const now = url.searchParams.get('now') || nowIso();
      return json(res, 200, { event: getCurrentEvent(now) });
    }

    if (method === 'POST' && pathname === '/api/cinema/events') {
      if (!isAuthorizedAdmin(req)) {
        return json(res, 401, { error: 'Unauthorized admin request.' });
      }
      const body = await readBody(req);
      const clean = validateEventInput(body);
      const createdAt = nowIso();
      const event = {
        id: store.idSeq++,
        ...clean,
        created_at: createdAt,
        updated_at: createdAt,
      };
      store.items.push(event);
      saveStore(store);
      return json(res, 201, { event });
    }

    if (method === 'POST' && pathname === '/api/users/profile-sync') {
      const body = await readBody(req);
      const clean = normalizeProfileSync(body);
      store.users[String(clean.user_id)] = clean;
      saveStore(store);
      return json(res, 200, { ok: true, profile: publicProfileView(clean.user_id) });
    }

    if (method === 'GET' && pathname.startsWith('/api/users/') && pathname.endsWith('/public')) {
      const parts = pathname.split('/').filter(Boolean);
      const userId = Number(parts[2] || 0);
      const profile = publicProfileView(userId);
      return json(res, 200, { profile });
    }

    if (method === 'POST' && pathname.startsWith('/api/users/') && pathname.endsWith('/follow')) {
      const parts = pathname.split('/').filter(Boolean);
      const targetId = Number(parts[2] || 0);
      const body = await readBody(req);
      const followerId = Number(body?.follower_id);
      if (!Number.isFinite(followerId) || followerId <= 0) {
        return json(res, 400, { error: 'follower_id is required.' });
      }
      followUser(followerId, targetId);
      saveStore(store);
      return json(res, 200, { ok: true });
    }

    if (method === 'DELETE' && pathname.startsWith('/api/users/') && pathname.endsWith('/follow')) {
      const parts = pathname.split('/').filter(Boolean);
      const targetId = Number(parts[2] || 0);
      const followerId = Number(url.searchParams.get('follower_id') || 0);
      if (!Number.isFinite(followerId) || followerId <= 0) {
        return json(res, 400, { error: 'follower_id is required.' });
      }
      unfollowUser(followerId, targetId);
      saveStore(store);
      return json(res, 200, { ok: true });
    }

    if (method === 'GET' && pathname.startsWith('/api/users/') && pathname.endsWith('/following')) {
      const parts = pathname.split('/').filter(Boolean);
      const userId = Number(parts[2] || 0);
      const ids = Array.isArray(store.follows[String(userId)]) ? store.follows[String(userId)] : [];
      const profiles = ids.map((id) => publicProfileView(id)).filter(Boolean);
      return json(res, 200, { users: profiles });
    }

    if (method === 'POST' && pathname === '/api/comments') {
      const body = await readBody(req);
      const clean = normalizeCommentInput(body);
      const comment = {
        id: store.commentIdSeq++,
        ...clean,
        public_user_id: resolvePublicUserIdForNickname(clean.nickname, clean.user_id),
        created_at: nowIso(),
      };
      store.comments.push(comment);
      saveStore(store);
      return json(res, 201, { comment });
    }

    if (method === 'GET' && pathname === '/api/comments') {
      const tmdbId = Number(url.searchParams.get('tmdb_id') || 0);
      if (!Number.isFinite(tmdbId) || tmdbId <= 0) {
        return json(res, 400, { error: 'tmdb_id is required.' });
      }
      const comments = store.comments
        .filter((c) => c.tmdb_id === tmdbId)
        .map((c) => ({ ...c, avatar_url: normalizeAvatarUrl(c.avatar_url) }))
        .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
      return json(res, 200, { comments });
    }

    if (method === 'POST' && pathname === '/api/admin/reset-all') {
      if (!isAuthorizedAdmin(req)) {
        return json(res, 403, { error: 'Forbidden.' });
      }
      resetAllStoreData();
      return json(res, 200, { ok: true });
    }

    if (method === 'POST' && pathname === '/api/admin/cloudinary/delete-image') {
      if (!isAuthorizedAdmin(req)) {
        return json(res, 403, { error: 'Forbidden.' });
      }
      const body = await readBody(req);
      const imageUrl = String(body?.image_url || '').trim();
      if (!imageUrl) {
        return json(res, 400, { error: 'image_url is required.' });
      }
      await destroyCloudinaryImageByUrl(imageUrl);
      return json(res, 200, { ok: true });
    }

    if (method === 'GET' && pathname === '/api/admin/cinema/cleanup-status') {
      if (!isAuthorizedAdmin(req)) {
        return json(res, 403, { error: 'Forbidden.' });
      }
      const now = Date.now();
      const pendingExpired = store.items
        .filter((item) => Number.isFinite(Date.parse(item?.end_at)) && Date.parse(item.end_at) < now)
        .map((item) => ({
          id: item.id,
          title: item.title,
          end_at: item.end_at,
          video_url: item.video_url,
          poster_url: item.poster_url,
        }));
      const failures = Array.from(expiredCleanupFailures.values())
        .sort((a, b) => Date.parse(String(b.last_attempt_at || '')) - Date.parse(String(a.last_attempt_at || '')));
      return json(res, 200, {
        ok: true,
        cleanup_in_progress: cleanupInProgress,
        pending_expired_count: pendingExpired.length,
        pending_expired: pendingExpired,
        failures_count: failures.length,
        failures,
      });
    }

    return json(res, 404, { error: 'Not found.' });
  } catch (err) {
    return json(res, 400, { error: err instanceof Error ? err.message : 'Request failed.' });
  }
});

const wss = new WsServerCtor({ server, path: '/ws' });
const rooms = new Map();

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, { clients: new Set(), messages: [], likes: new Set() });
  }
  return rooms.get(roomId);
}

function safeSend(ws, payload) {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify(payload));
}

function userKeyFor(ws) {
  if (Number.isFinite(ws?.user?.userId) && ws.user.userId > 0) {
    return `u:${ws.user.userId}`;
  }
  return `g:${ws.sessionId}`;
}

function broadcastRoomStats(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  const payload = {
    type: 'stats',
    room: roomId,
    viewers: room.clients.size,
    likes: room.likes.size,
  };
  room.clients.forEach((client) => safeSend(client, payload));
}

wss.on('connection', (ws) => {
  ws.sessionId = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  ws.room = null;
  ws.user = { userId: null, nickname: 'guest', avatarUrl: null };

  ws.on('message', (raw) => {
    try {
      const data = JSON.parse(String(raw));
      if (data.type === 'join' && data.room) {
        const roomId = String(data.room);
        const room = getRoom(roomId);
        room.clients.add(ws);
        ws.room = roomId;
        ws.user = {
          userId: Number.isFinite(Number(data.userId)) ? Number(data.userId) : null,
          nickname: (data.nickname || 'guest').toString().slice(0, 40),
          avatarUrl: data.avatarUrl ? String(data.avatarUrl).slice(0, 400) : null,
        };
        safeSend(ws, {
          type: 'history',
          room: roomId,
          messages: room.messages.slice(-80),
        });
        broadcastRoomStats(roomId);
        return;
      }

      if (data.type === 'message' && ws.room && data.text) {
        const room = getRoom(ws.room);
        const message = {
          id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
          eventId: Number.isFinite(Number(data.eventId)) ? Number(data.eventId) : 0,
          userId: ws.user.userId,
          nickname: ws.user.nickname,
          avatarUrl: ws.user.avatarUrl,
          text: String(data.text).slice(0, 500),
          createdAt: nowIso(),
        };
        room.messages.push(message);
        if (room.messages.length > 300) room.messages.shift();
        room.clients.forEach((client) => {
          safeSend(client, { type: 'message', room: ws.room, message });
        });
        return;
      }

      if (data.type === 'like' && ws.room) {
        const room = getRoom(ws.room);
        const key = userKeyFor(ws);
        if (data.liked) room.likes.add(key);
        else room.likes.delete(key);
        safeSend(ws, { type: 'liked', room: ws.room, liked: !!data.liked });
        broadcastRoomStats(ws.room);
      }
    } catch {
    }
  });

  ws.on('close', () => {
    if (!ws.room) return;
    const room = rooms.get(ws.room);
    if (!room) return;
    room.clients.delete(ws);
    room.likes.delete(userKeyFor(ws));
    broadcastRoomStats(ws.room);
    if (room.clients.size === 0 && room.messages.length === 0 && room.likes.size === 0) {
      rooms.delete(ws.room);
    }
  });
});

setInterval(() => {
  cleanupExpiredCinemaEvents().catch((err) => {
    console.error('Expired cinema cleanup failed:', err instanceof Error ? err.message : err);
  });
}, EXPIRED_CLEANUP_INTERVAL_MS);

server.listen(port, () => {
  console.log(`Cinema backend running on http://localhost:${port}`);
  console.log(`REST:  GET /health, GET /api/cinema/current, GET /api/cinema/latest, POST /api/cinema/events`);
  console.log(`WS:    ws://localhost:${port}/ws`);
});
