/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const WsLib = require('ws');
const WsServerCtor = WsLib.WebSocketServer || WsLib.Server;

const port = Number(process.env.PORT || process.env.CINEMA_API_PORT || process.env.CINEMA_WS_PORT || 8787);
const adminApiKey = String(process.env.ADMIN_API_KEY || '').trim();
const cloudinaryCloudName = String(process.env.CLOUDINARY_CLOUD_NAME || '').trim();
const cloudinaryApiKey = String(process.env.CLOUDINARY_API_KEY || '').trim();
const cloudinaryApiSecret = String(process.env.CLOUDINARY_API_SECRET || '').trim();
const runtimeEnv = String(process.env.NODE_ENV || '').trim().toLowerCase();
const isProduction = runtimeEnv === 'production';

if (isProduction && !adminApiKey) {
  console.error('ADMIN_API_KEY is required in production.');
  process.exit(1);
}

const configuredDataPath = String(process.env.CINEMA_DATA_FILE || '').trim();
const dataFile = configuredDataPath
  ? path.resolve(configuredDataPath)
  : path.join(__dirname, 'data', 'cinema-events.json');
const dataDir = path.dirname(dataFile);

function createEmptyStoreState() {
  return {
    idSeq: 1,
    items: [],
    commentIdSeq: 1,
    comments: [],
    users: {},
    userSessions: {},
    follows: {},
    movieStates: {},
    galleryIdSeq: 1,
    galleryCommentIdSeq: 1,
    galleryItems: [],
    galleryLikes: [],
    galleryFavorites: [],
    galleryComments: [],
  };
}

function ensureStore() {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(dataFile)) {
    fs.writeFileSync(dataFile, JSON.stringify(createEmptyStoreState(), null, 2), 'utf8');
  }
}

function loadStore() {
  ensureStore();
  try {
    const parsed = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    const fallback = createEmptyStoreState();
    const galleryItems = Array.isArray(parsed?.galleryItems) ? parsed.galleryItems : [];
    const galleryComments = Array.isArray(parsed?.galleryComments) ? parsed.galleryComments : [];
    return {
      idSeq: Number(parsed?.idSeq || 1),
      items: Array.isArray(parsed?.items) ? parsed.items : [],
      commentIdSeq: Number(parsed?.commentIdSeq || 1),
      comments: Array.isArray(parsed?.comments) ? parsed.comments : [],
      users: parsed?.users && typeof parsed.users === 'object' ? parsed.users : {},
      userSessions: parsed?.userSessions && typeof parsed.userSessions === 'object' ? parsed.userSessions : {},
      follows: parsed?.follows && typeof parsed.follows === 'object' ? parsed.follows : {},
      movieStates: parsed?.movieStates && typeof parsed.movieStates === 'object' ? parsed.movieStates : {},
      galleryIdSeq: Number(
        parsed?.galleryIdSeq ||
          (galleryItems.reduce((acc, row) => Math.max(acc, parsePositiveNumber(row?.id) || 0), 0) + 1) ||
          fallback.galleryIdSeq
      ),
      galleryCommentIdSeq: Number(
        parsed?.galleryCommentIdSeq ||
          (galleryComments.reduce((acc, row) => Math.max(acc, parsePositiveNumber(row?.id) || 0), 0) + 1) ||
          fallback.galleryCommentIdSeq
      ),
      galleryItems,
      galleryLikes: Array.isArray(parsed?.galleryLikes) ? parsed.galleryLikes : [],
      galleryFavorites: Array.isArray(parsed?.galleryFavorites) ? parsed.galleryFavorites : [],
      galleryComments,
    };
  } catch {
    return createEmptyStoreState();
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
    'access-control-allow-headers': 'content-type,x-admin-key,x-user-token',
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
  const movieState = store.movieStates[String(userId)] ? ensureUserMovieState(userId) : null;
  const privacy = movieState
    ? normalizeMoviePrivacy(movieState.privacy, profile.privacy)
    : normalizeMoviePrivacy(profile.privacy, DEFAULT_MOVIE_PRIVACY);
  const watchlistData =
    Array.isArray(profile.watchlist) && profile.watchlist.length > 0
      ? profile.watchlist
      : movieState?.watchlist ?? [];
  const favoritesData =
    Array.isArray(profile.favorites) && profile.favorites.length > 0
      ? profile.favorites
      : movieState?.favorites ?? [];
  const watchedData =
    Array.isArray(profile.watched) && profile.watched.length > 0
      ? profile.watched
      : movieState?.watched ?? [];
  const ratedData =
    Array.isArray(profile.rated) && profile.rated.length > 0
      ? profile.rated
      : movieState?.ratings ?? [];
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
    watchlist: privacy.watchlist ? watchlistData : [],
    favorites: privacy.favorites ? favoritesData : [],
    watched: privacy.watched ? watchedData : [],
    rated: privacy.rated ? ratedData : [],
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

const DEFAULT_MOVIE_PRIVACY = Object.freeze({
  watchlist: false,
  favorites: false,
  watched: false,
  rated: false,
});

function parsePositiveNumber(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.floor(parsed);
}

function parseOptionalNumber(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
}

function normalizeIso(value, fallback = nowIso()) {
  const clean = String(value || '').trim();
  if (!clean) return fallback;
  const parsed = Date.parse(clean);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : fallback;
}

function normalizeMediaType(value) {
  return String(value || '').toLowerCase() === 'tv' ? 'tv' : 'movie';
}

function normalizeText(value, max = 400) {
  return String(value || '').trim().slice(0, max);
}

function normalizeImageUrl(input) {
  const value = input ? String(input).trim() : '';
  if (!value) return null;
  if (/^data:image\/[a-zA-Z0-9.+-]+;base64,/i.test(value)) {
    return value.length <= 2_000_000 ? value : null;
  }
  if (/^https?:\/\//i.test(value)) return value.slice(0, 2000);
  return null;
}

function normalizeMoviePrivacy(input, fallback = DEFAULT_MOVIE_PRIVACY) {
  return {
    watchlist: typeof input?.watchlist === 'boolean' ? input.watchlist : !!fallback.watchlist,
    favorites: typeof input?.favorites === 'boolean' ? input.favorites : !!fallback.favorites,
    watched: typeof input?.watched === 'boolean' ? input.watched : !!fallback.watched,
    rated: typeof input?.rated === 'boolean' ? input.rated : !!fallback.rated,
  };
}

function normalizeMovieList(list, maxLen = 800) {
  const entries = Array.isArray(list) ? list : [];
  const unique = new Map();
  for (const row of entries) {
    const tmdbId = parsePositiveNumber(row?.tmdb_id ?? row?.tmdbId);
    if (!tmdbId) continue;
    const createdAt = normalizeIso(row?.created_at ?? row?.createdAt);
    unique.set(tmdbId, {
      tmdb_id: tmdbId,
      media_type: normalizeMediaType(row?.media_type ?? row?.mediaType),
      created_at: createdAt,
    });
  }
  return Array.from(unique.values())
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
    .slice(0, maxLen);
}

function normalizeMovieRatings(list, maxLen = 800) {
  const entries = Array.isArray(list) ? list : [];
  const unique = new Map();
  for (const row of entries) {
    const tmdbId = parsePositiveNumber(row?.tmdb_id ?? row?.tmdbId);
    if (!tmdbId) continue;
    const ratingRaw = parseOptionalNumber(row?.rating);
    if (!Number.isFinite(ratingRaw)) continue;
    const rating = Math.max(0, Math.min(10, ratingRaw));
    const createdAt = normalizeIso(row?.created_at ?? row?.createdAt);
    const updatedAt = normalizeIso(row?.updated_at ?? row?.updatedAt ?? createdAt, createdAt);
    unique.set(tmdbId, {
      tmdb_id: tmdbId,
      media_type: normalizeMediaType(row?.media_type ?? row?.mediaType),
      rating,
      created_at: createdAt,
      updated_at: updatedAt,
    });
  }
  return Array.from(unique.values())
    .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))
    .slice(0, maxLen);
}

function ensureUserMovieState(userId) {
  const key = String(userId);
  const existing = store.movieStates[key];
  if (existing && typeof existing === 'object') {
    const normalized = {
      user_id: Number(existing.user_id) || userId,
      privacy: normalizeMoviePrivacy(existing.privacy, DEFAULT_MOVIE_PRIVACY),
      watchlist: normalizeMovieList(existing.watchlist, 1200),
      favorites: normalizeMovieList(existing.favorites, 1200),
      watched: normalizeMovieList(existing.watched, 1200),
      ratings: normalizeMovieRatings(existing.ratings, 1200),
      updated_at: normalizeIso(existing.updated_at, nowIso()),
    };
    store.movieStates[key] = normalized;
    return normalized;
  }
  const created = {
    user_id: userId,
    privacy: { ...DEFAULT_MOVIE_PRIVACY },
    watchlist: [],
    favorites: [],
    watched: [],
    ratings: [],
    updated_at: nowIso(),
  };
  store.movieStates[key] = created;
  return created;
}

function serializeUserMovieState(state) {
  return {
    user_id: Number(state.user_id),
    privacy: normalizeMoviePrivacy(state.privacy, DEFAULT_MOVIE_PRIVACY),
    watchlist: normalizeMovieList(state.watchlist, 1200),
    favorites: normalizeMovieList(state.favorites, 1200),
    watched: normalizeMovieList(state.watched, 1200),
    ratings: normalizeMovieRatings(state.ratings, 1200),
    updated_at: normalizeIso(state.updated_at, nowIso()),
  };
}

function findMovieListEntry(list, tmdbId) {
  return list.findIndex((entry) => Number(entry.tmdb_id) === tmdbId);
}

function toggleMovieListEntry(userId, listKey, tmdbId, mediaType) {
  const state = ensureUserMovieState(userId);
  const list = Array.isArray(state[listKey]) ? state[listKey] : [];
  const index = findMovieListEntry(list, tmdbId);
  if (index >= 0) {
    list.splice(index, 1);
    state[listKey] = list;
    state.updated_at = nowIso();
    return false;
  }
  list.unshift({
    tmdb_id: tmdbId,
    media_type: normalizeMediaType(mediaType),
    created_at: nowIso(),
  });
  state[listKey] = normalizeMovieList(list, 1200);
  state.updated_at = nowIso();
  return true;
}

function setMovieWatchedState(userId, tmdbId, mediaType, watched) {
  const state = ensureUserMovieState(userId);
  const list = Array.isArray(state.watched) ? state.watched : [];
  const index = findMovieListEntry(list, tmdbId);
  if (!watched) {
    if (index >= 0) list.splice(index, 1);
    state.watched = list;
    state.updated_at = nowIso();
    return false;
  }
  if (index >= 0) {
    list[index] = {
      ...list[index],
      media_type: normalizeMediaType(mediaType),
      created_at: list[index].created_at || nowIso(),
    };
  } else {
    list.unshift({
      tmdb_id: tmdbId,
      media_type: normalizeMediaType(mediaType),
      created_at: nowIso(),
    });
  }
  state.watched = normalizeMovieList(list, 1200);
  state.updated_at = nowIso();
  return true;
}

function setMovieRatingState(userId, tmdbId, mediaType, ratingInput) {
  const state = ensureUserMovieState(userId);
  const list = Array.isArray(state.ratings) ? state.ratings : [];
  const index = findMovieListEntry(list, tmdbId);
  const ratingParsed = parseOptionalNumber(ratingInput);
  if (!Number.isFinite(ratingParsed) || ratingParsed <= 0) {
    if (index >= 0) list.splice(index, 1);
    state.ratings = list;
    state.updated_at = nowIso();
    return null;
  }
  const rating = Math.max(0, Math.min(10, ratingParsed));
  const now = nowIso();
  if (index >= 0) {
    const prev = list[index];
    list[index] = {
      ...prev,
      tmdb_id: tmdbId,
      media_type: normalizeMediaType(mediaType),
      rating,
      created_at: prev.created_at || now,
      updated_at: now,
    };
  } else {
    list.unshift({
      tmdb_id: tmdbId,
      media_type: normalizeMediaType(mediaType),
      rating,
      created_at: now,
      updated_at: now,
    });
  }
  state.ratings = normalizeMovieRatings(list, 1200);
  state.updated_at = now;
  return rating;
}

function getMovieItemState(userId, tmdbId) {
  const state = ensureUserMovieState(userId);
  const watch = findMovieListEntry(state.watchlist, tmdbId) >= 0;
  const fav = findMovieListEntry(state.favorites, tmdbId) >= 0;
  const watched = findMovieListEntry(state.watched, tmdbId) >= 0;
  const ratingEntry = state.ratings.find((entry) => Number(entry.tmdb_id) === tmdbId) || null;
  return {
    in_watchlist: watch,
    in_favorites: fav,
    watched,
    rating: ratingEntry ? Number(ratingEntry.rating) : null,
  };
}

function getMovieEngagementCounts(tmdbId, mediaType) {
  const type = normalizeMediaType(mediaType);
  let favorites = 0;
  let watched = 0;
  let rated = 0;
  for (const [rawUserId, value] of Object.entries(store.movieStates || {})) {
    const userId = parsePositiveNumber(rawUserId) || parsePositiveNumber(value?.user_id);
    if (!userId) continue;
    const state = ensureUserMovieState(userId);
    if (state.favorites.some((entry) => Number(entry.tmdb_id) === tmdbId && normalizeMediaType(entry.media_type) === type)) {
      favorites += 1;
    }
    if (state.watched.some((entry) => Number(entry.tmdb_id) === tmdbId && normalizeMediaType(entry.media_type) === type)) {
      watched += 1;
    }
    if (state.ratings.some((entry) => Number(entry.tmdb_id) === tmdbId && normalizeMediaType(entry.media_type) === type)) {
      rated += 1;
    }
  }
  return { favorites, watched, rated };
}

function normalizeGalleryPalette(input) {
  if (!Array.isArray(input)) return [];
  return input
    .map((value) => String(value || '').trim())
    .filter((value) => /^#[0-9a-fA-F]{6}$/.test(value))
    .slice(0, 16);
}

function normalizeGalleryDetails(input) {
  if (!input || typeof input !== 'object') return {};
  const out = {};
  for (const [key, value] of Object.entries(input)) {
    const cleanKey = normalizeText(key, 80);
    const cleanValue = normalizeText(value, 500);
    if (!cleanKey || !cleanValue) continue;
    out[cleanKey] = cleanValue;
  }
  return out;
}

function normalizeGalleryTag(value) {
  const tag = normalizeText(value, 50).toLowerCase();
  return tag || 'gallery';
}

function normalizeGalleryHeight(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 260;
  return Math.max(160, Math.min(560, Math.round(parsed)));
}

function normalizeGalleryItemPayload(input) {
  const title = normalizeText(input?.title, 120);
  const image = normalizeImageUrl(input?.image || input?.image_url || input?.imageUrl);
  if (!title) throw new Error('title is required.');
  if (!image) throw new Error('image is required.');
  return {
    title,
    image,
    tag: normalizeGalleryTag(input?.tag),
    height: normalizeGalleryHeight(input?.height),
    shot_id: normalizeText(input?.shot_id ?? input?.shotId, 120) || null,
    title_header: normalizeText(input?.title_header ?? input?.titleHeader, 120) || null,
    image_id: normalizeText(input?.image_id ?? input?.imageId, 120) || null,
    image_url: normalizeImageUrl(input?.image_url ?? input?.imageUrl ?? image) || image,
    palette_hex: normalizeGalleryPalette(input?.palette_hex ?? input?.paletteHex ?? []),
    details: normalizeGalleryDetails(input?.details ?? {}),
    created_at: nowIso(),
  };
}

function getGalleryItemById(galleryId) {
  return store.galleryItems.find((item) => Number(item.id) === Number(galleryId)) || null;
}

function serializeGalleryItemForFeed(item, userId) {
  const galleryId = Number(item.id);
  const likesCount = store.galleryLikes.filter((row) => Number(row.gallery_id) === galleryId).length;
  const commentsCount = store.galleryComments.filter((row) => Number(row.gallery_id) === galleryId).length;
  const likedByMe = store.galleryLikes.some(
    (row) => Number(row.gallery_id) === galleryId && Number(row.user_id) === Number(userId)
  );
  const favoritedByMe = store.galleryFavorites.some(
    (row) => Number(row.gallery_id) === galleryId && Number(row.user_id) === Number(userId)
  );
  return {
    ...item,
    likes_count: likesCount,
    comments_count: commentsCount,
    liked_by_me: likedByMe,
    favorited_by_me: favoritedByMe,
  };
}

function resolveNicknameForUser(userId, fallback = 'user') {
  const profile = store.users[String(userId)];
  if (!profile) return fallback;
  const nickname = normalizeText(profile.nickname, 40);
  return nickname || fallback;
}

function resolveAvatarForUser(userId, fallback = null) {
  const profile = store.users[String(userId)];
  const avatarFromProfile = normalizeAvatarUrl(profile?.avatar_url);
  if (avatarFromProfile) return avatarFromProfile;
  return normalizeAvatarUrl(fallback);
}

function resolveCommentIdentity(row) {
  const fallbackUserId = parsePositiveNumber(row?.user_id) || null;
  const publicUserId =
    parsePositiveNumber(row?.public_user_id) || resolvePublicUserIdForNickname(row?.nickname, fallbackUserId) || fallbackUserId;
  const fallbackNickname =
    normalizeText(row?.nickname, 40) || (publicUserId ? `user_${publicUserId}` : fallbackUserId ? `user_${fallbackUserId}` : 'user');
  const nickname = publicUserId ? resolveNicknameForUser(publicUserId, fallbackNickname) : fallbackNickname;
  const avatarUrl = publicUserId ? resolveAvatarForUser(publicUserId, row?.avatar_url) : normalizeAvatarUrl(row?.avatar_url);
  return {
    public_user_id: publicUserId,
    nickname,
    avatar_url: avatarUrl,
  };
}

function syncStoredCommentIdentityForUser(userId, prevNickname, nextNickname, nextAvatarUrl) {
  const prevLower = String(prevNickname || '').trim().toLowerCase();
  const nextLower = String(nextNickname || '').trim().toLowerCase();
  const normalizedAvatar = normalizeAvatarUrl(nextAvatarUrl);
  const matchesUser = (row) => {
    const publicUserId = parsePositiveNumber(row?.public_user_id);
    const rowUserId = parsePositiveNumber(row?.user_id);
    const rowNickname = String(row?.nickname || '').trim().toLowerCase();
    if (publicUserId === userId) return true;
    if (rowUserId === userId) return true;
    if (prevLower && rowNickname === prevLower) return true;
    if (nextLower && rowNickname === nextLower) return true;
    return false;
  };

  for (const row of store.comments) {
    if (!matchesUser(row)) continue;
    row.public_user_id = userId;
    row.nickname = nextNickname;
    row.avatar_url = normalizedAvatar;
  }

  for (const row of store.galleryComments) {
    if (!matchesUser(row)) continue;
    row.public_user_id = userId;
    row.nickname = nextNickname;
    row.avatar_url = normalizedAvatar;
  }
}

function normalizeGalleryCommentPayload(input, galleryIdFromPath) {
  const userId = parsePositiveNumber(input?.user_id);
  const galleryId = parsePositiveNumber(input?.gallery_id ?? galleryIdFromPath);
  const text = normalizeText(input?.text, 1000);
  if (!userId) throw new Error('user_id is required.');
  if (!galleryId) throw new Error('gallery_id is required.');
  if (!text) throw new Error('Comment text is required.');
  const parentId = parsePositiveNumber(input?.parent_id);
  const fallbackNickname = `user_${userId}`;
  const rawNickname = normalizeText(input?.nickname, 40) || resolveNicknameForUser(userId, fallbackNickname);
  const publicUserId = resolvePublicUserIdForNickname(rawNickname, userId);
  const nickname = resolveNicknameForUser(publicUserId, rawNickname);
  const avatarUrl = resolveAvatarForUser(publicUserId, input?.avatar_url);
  return {
    user_id: userId,
    public_user_id: publicUserId,
    gallery_id: galleryId,
    nickname,
    avatar_url: avatarUrl,
    text,
    parent_id: parentId || null,
  };
}

function toggleGalleryReaction(list, userId, galleryId) {
  const idx = list.findIndex(
    (row) => Number(row.user_id) === Number(userId) && Number(row.gallery_id) === Number(galleryId)
  );
  if (idx >= 0) {
    list.splice(idx, 1);
    return false;
  }
  list.push({
    user_id: Number(userId),
    gallery_id: Number(galleryId),
    created_at: nowIso(),
  });
  return true;
}

function isAuthorizedAdmin(req) {
  if (!adminApiKey) return false;
  const key = String(req.headers['x-admin-key'] || '').trim();
  return key && key === adminApiKey;
}

function getUserTokenFromRequest(req) {
  return String(req.headers['x-user-token'] || '').trim();
}

function getUserSession(userIdInput) {
  const userId = parsePositiveNumber(userIdInput);
  if (!userId) return null;
  const entry = store.userSessions ? store.userSessions[String(userId)] : null;
  if (!entry || typeof entry !== 'object') return null;
  const token = String(entry.token || '').trim();
  if (!token) return null;
  return {
    user_id: userId,
    token,
    created_at: String(entry.created_at || nowIso()),
    updated_at: String(entry.updated_at || nowIso()),
  };
}

function upsertUserSession(userIdInput, tokenInput) {
  const userId = parsePositiveNumber(userIdInput);
  if (!userId) throw new Error('Invalid user id for session.');
  const token = String(tokenInput || '').trim() || crypto.randomBytes(24).toString('hex');
  const now = nowIso();
  const existing = getUserSession(userId);
  if (!store.userSessions || typeof store.userSessions !== 'object') {
    store.userSessions = {};
  }
  store.userSessions[String(userId)] = {
    user_id: userId,
    token,
    created_at: existing?.created_at || now,
    updated_at: now,
  };
  return store.userSessions[String(userId)];
}

function requireUserSession(req, userIdInput) {
  const userId = parsePositiveNumber(userIdInput);
  if (!userId) return { ok: false, status: 400, error: 'user_id is required.' };
  const session = getUserSession(userId);
  if (!session) return { ok: false, status: 401, error: 'Session missing. Sync profile first.' };
  const token = getUserTokenFromRequest(req);
  if (!token) return { ok: false, status: 401, error: 'Missing x-user-token header.' };
  if (token !== session.token) return { ok: false, status: 403, error: 'Invalid user session token.' };
  return { ok: true, userId };
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

function isCloudinaryImageOwnedByUser(imageUrl, userIdInput) {
  const userId = parsePositiveNumber(userIdInput);
  if (!userId) return false;
  const publicId = extractCloudinaryPublicId(imageUrl);
  if (!publicId) return false;
  return new RegExp(`(^|/)u-${userId}(/|$)`).test(publicId);
}

function signCloudinaryDestroy(publicId, timestamp) {
  return signCloudinaryParams({ public_id: publicId, timestamp, invalidate: 'true' });
}

function signCloudinaryParams(params) {
  const entries = Object.entries(params || {})
    .filter(([, value]) => value !== null && value !== undefined && String(value).trim() !== '')
    .map(([key, value]) => [String(key), String(value)])
    .sort(([a], [b]) => a.localeCompare(b));
  const payload = `${entries.map(([key, value]) => `${key}=${value}`).join('&')}${cloudinaryApiSecret}`;
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

function normalizeCloudinaryResourceType(input) {
  return String(input || '').toLowerCase() === 'video' ? 'video' : 'image';
}

function sanitizeCloudinaryPathSegment(value, fallback) {
  const clean = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  return clean || fallback;
}

function createCloudinaryUploadSignaturePayload(input) {
  if (!cloudinaryCloudName || !cloudinaryApiKey || !cloudinaryApiSecret) {
    throw new Error('Cloudinary server credentials are missing.');
  }
  const resourceType = normalizeCloudinaryResourceType(input?.resource_type ?? input?.resourceType);
  const userId = parsePositiveNumber(input?.user_id ?? input?.userId) || null;
  const folderRoot = sanitizeCloudinaryPathSegment(input?.folder, 'movie-rec');
  const folder = userId ? `${folderRoot}/u-${userId}` : folderRoot;
  const timestamp = Math.floor(Date.now() / 1000);
  const randomSuffix = crypto.randomBytes(4).toString('hex');
  const publicId = `${folder}/${resourceType}-${Date.now()}-${randomSuffix}`;
  const signature = signCloudinaryParams({
    public_id: publicId,
    timestamp,
  });
  return {
    resource_type: resourceType,
    upload_url: `https://api.cloudinary.com/v1_1/${cloudinaryCloudName}/${resourceType}/upload`,
    cloud_name: cloudinaryCloudName,
    api_key: cloudinaryApiKey,
    timestamp,
    signature,
    public_id: publicId,
    folder,
  };
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
  store.userSessions = {};
  store.follows = {};
  store.movieStates = {};
  store.galleryIdSeq = 1;
  store.galleryCommentIdSeq = 1;
  store.galleryItems = [];
  store.galleryLikes = [];
  store.galleryFavorites = [];
  store.galleryComments = [];
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

    if (method === 'POST' && pathname === '/api/media/cloudinary/sign-upload') {
      const body = await readBody(req);
      const adminAuthorized = isAuthorizedAdmin(req);
      const requestedUserId = parsePositiveNumber(body?.user_id ?? body?.userId);
      let activeSession = null;
      if (!adminAuthorized) {
        const sessionCheck = requireUserSession(req, requestedUserId);
        if (!sessionCheck.ok) {
          return json(res, sessionCheck.status, { error: sessionCheck.error });
        }
        activeSession = getUserSession(requestedUserId);
        const requestedResourceType = normalizeCloudinaryResourceType(body?.resource_type ?? body?.resourceType);
        if (requestedResourceType !== 'image') {
          return json(res, 403, { error: 'Only image uploads are allowed for user sessions.' });
        }
      }
      const payload = createCloudinaryUploadSignaturePayload(
        adminAuthorized
          ? body
          : {
              resource_type: 'image',
              user_id: requestedUserId,
              folder: 'movie-rec-avatars',
            }
      );
      if (activeSession?.token) {
        return json(res, 200, { ...payload, session_token: activeSession.token });
      }
      return json(res, 200, payload);
    }

    if (method === 'POST' && pathname === '/api/media/cloudinary/delete-image') {
      const body = await readBody(req);
      const imageUrl = String(body?.image_url || '').trim();
      const userId = parsePositiveNumber(body?.user_id ?? body?.userId);
      if (!imageUrl) {
        return json(res, 400, { error: 'image_url is required.' });
      }
      if (!userId) {
        return json(res, 400, { error: 'user_id is required.' });
      }
      const sessionCheck = requireUserSession(req, userId);
      if (!sessionCheck.ok) {
        return json(res, sessionCheck.status, { error: sessionCheck.error });
      }
      if (!isCloudinaryImageOwnedByUser(imageUrl, userId)) {
        return json(res, 403, { error: 'You can delete only your own Cloudinary avatar image.' });
      }
      await destroyCloudinaryImageByUrl(imageUrl);
      return json(res, 200, { ok: true });
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

    if (method === 'POST' && pathname === '/api/users/session/bootstrap') {
      const body = await readBody(req);
      const userId = parsePositiveNumber(body?.user_id ?? body?.userId);
      const nickname = String(body?.nickname || '').trim();
      if (!userId) {
        return json(res, 400, { error: 'user_id is required.' });
      }
      if (!nickname) {
        return json(res, 400, { error: 'nickname is required.' });
      }
      const existingProfile = store.users[String(userId)];
      if (existingProfile) {
        const existingNickname = String(existingProfile.nickname || '').trim().toLowerCase();
        if (!existingNickname || existingNickname !== nickname.toLowerCase()) {
          return json(res, 403, { error: 'Nickname mismatch for session bootstrap.' });
        }
      }
      const session = upsertUserSession(userId, null);
      saveStore(store);
      return json(res, 200, { ok: true, session_token: session.token });
    }

    if (method === 'POST' && pathname === '/api/users/profile-sync') {
      const body = await readBody(req);
      const clean = normalizeProfileSync(body);
      let activeSession = getUserSession(clean.user_id);
      const existingProfile = store.users[String(clean.user_id)];
      const prevNickname = normalizeText(existingProfile?.nickname, 40) || '';
      if (activeSession) {
        const token = getUserTokenFromRequest(req);
        if (!token || token !== activeSession.token) {
          const existingNickname = String(existingProfile?.nickname || '').trim().toLowerCase();
          const requestedNickname = String(clean.nickname || '').trim().toLowerCase();
          if (!existingNickname || existingNickname !== requestedNickname) {
            return json(res, 403, { error: 'Invalid user session token.' });
          }
          activeSession = upsertUserSession(clean.user_id, null);
        }
      } else {
        if (existingProfile) {
          const existingNickname = String(existingProfile.nickname || '').trim().toLowerCase();
          const requestedNickname = String(clean.nickname || '').trim().toLowerCase();
          if (!existingNickname || existingNickname !== requestedNickname) {
            return json(res, 403, { error: 'Profile sync requires matching nickname for first session bootstrap.' });
          }
        }
        activeSession = upsertUserSession(clean.user_id, null);
      }
      store.users[String(clean.user_id)] = clean;
      syncStoredCommentIdentityForUser(clean.user_id, prevNickname, clean.nickname, clean.avatar_url);
      saveStore(store);
      return json(res, 200, {
        ok: true,
        profile: publicProfileView(clean.user_id),
        session_token: activeSession.token,
      });
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

    if (method === 'GET' && pathname.startsWith('/api/users/') && pathname.endsWith('/movie-state')) {
      const parts = pathname.split('/').filter(Boolean);
      const userId = parsePositiveNumber(parts[2]);
      if (!userId) return json(res, 400, { error: 'Invalid user id.' });
      const state = ensureUserMovieState(userId);
      const tmdbId = parsePositiveNumber(url.searchParams.get('tmdb_id'));
      if (tmdbId) {
        return json(res, 200, {
          state: serializeUserMovieState(state),
          item_state: getMovieItemState(userId, tmdbId),
        });
      }
      return json(res, 200, { state: serializeUserMovieState(state) });
    }

    if (method === 'POST' && pathname.startsWith('/api/users/') && pathname.endsWith('/movie-state')) {
      const parts = pathname.split('/').filter(Boolean);
      const userId = parsePositiveNumber(parts[2]);
      if (!userId) return json(res, 400, { error: 'Invalid user id.' });
      const body = await readBody(req);
      const state = ensureUserMovieState(userId);
      if ('privacy' in body) {
        state.privacy = normalizeMoviePrivacy(body.privacy, state.privacy);
      }
      if ('watchlist' in body) state.watchlist = normalizeMovieList(body.watchlist, 1200);
      if ('favorites' in body) state.favorites = normalizeMovieList(body.favorites, 1200);
      if ('watched' in body) state.watched = normalizeMovieList(body.watched, 1200);
      if ('ratings' in body) state.ratings = normalizeMovieRatings(body.ratings, 1200);
      state.updated_at = nowIso();
      saveStore(store);
      return json(res, 200, { state: serializeUserMovieState(state) });
    }

    if (method === 'POST' && pathname.startsWith('/api/users/') && pathname.endsWith('/movie-state/toggle')) {
      const parts = pathname.split('/').filter(Boolean);
      const userId = parsePositiveNumber(parts[2]);
      if (!userId) return json(res, 400, { error: 'Invalid user id.' });
      const body = await readBody(req);
      const tmdbId = parsePositiveNumber(body?.tmdb_id);
      if (!tmdbId) return json(res, 400, { error: 'tmdb_id is required.' });
      const list = String(body?.list || '').trim().toLowerCase();
      if (!['watchlist', 'favorites', 'watched'].includes(list)) {
        return json(res, 400, { error: 'list must be watchlist, favorites or watched.' });
      }
      const active = toggleMovieListEntry(userId, list, tmdbId, body?.media_type);
      saveStore(store);
      return json(res, 200, { ok: true, active, item_state: getMovieItemState(userId, tmdbId) });
    }

    if (method === 'POST' && pathname.startsWith('/api/users/') && pathname.endsWith('/movie-state/watched')) {
      const parts = pathname.split('/').filter(Boolean);
      const userId = parsePositiveNumber(parts[2]);
      if (!userId) return json(res, 400, { error: 'Invalid user id.' });
      const body = await readBody(req);
      const tmdbId = parsePositiveNumber(body?.tmdb_id);
      if (!tmdbId) return json(res, 400, { error: 'tmdb_id is required.' });
      const watched = !!body?.watched;
      const active = setMovieWatchedState(userId, tmdbId, body?.media_type, watched);
      saveStore(store);
      return json(res, 200, { ok: true, watched: active, item_state: getMovieItemState(userId, tmdbId) });
    }

    if (method === 'POST' && pathname.startsWith('/api/users/') && pathname.endsWith('/movie-state/rating')) {
      const parts = pathname.split('/').filter(Boolean);
      const userId = parsePositiveNumber(parts[2]);
      if (!userId) return json(res, 400, { error: 'Invalid user id.' });
      const body = await readBody(req);
      const tmdbId = parsePositiveNumber(body?.tmdb_id);
      if (!tmdbId) return json(res, 400, { error: 'tmdb_id is required.' });
      const rating = setMovieRatingState(userId, tmdbId, body?.media_type, body?.rating);
      saveStore(store);
      return json(res, 200, { ok: true, rating, item_state: getMovieItemState(userId, tmdbId) });
    }

    if (method === 'POST' && pathname.startsWith('/api/users/') && pathname.endsWith('/movie-state/privacy')) {
      const parts = pathname.split('/').filter(Boolean);
      const userId = parsePositiveNumber(parts[2]);
      if (!userId) return json(res, 400, { error: 'Invalid user id.' });
      const body = await readBody(req);
      const state = ensureUserMovieState(userId);
      state.privacy = normalizeMoviePrivacy(body?.privacy, state.privacy);
      state.updated_at = nowIso();
      saveStore(store);
      return json(res, 200, { ok: true, privacy: state.privacy });
    }

    if (method === 'GET' && pathname.startsWith('/api/users/') && pathname.endsWith('/gallery-favorites')) {
      const parts = pathname.split('/').filter(Boolean);
      const userId = parsePositiveNumber(parts[2]);
      if (!userId) return json(res, 400, { error: 'Invalid user id.' });
      const favorites = store.galleryFavorites
        .filter((row) => Number(row.user_id) === userId)
        .sort((a, b) => Date.parse(String(b.created_at || '')) - Date.parse(String(a.created_at || '')));
      const used = new Set();
      const items = [];
      for (const fav of favorites) {
        const galleryId = Number(fav.gallery_id);
        if (used.has(galleryId)) continue;
        const item = getGalleryItemById(galleryId);
        if (!item) continue;
        used.add(galleryId);
        items.push(item);
      }
      return json(res, 200, { items });
    }

    if (method === 'GET' && pathname === '/api/gallery') {
      const userId = parsePositiveNumber(url.searchParams.get('user_id')) || 0;
      const query = normalizeText(url.searchParams.get('query') || url.searchParams.get('q') || '', 120).toLowerCase();
      const items = store.galleryItems
        .filter((item) => {
          if (!query) return true;
          const detailsText = Object.entries(item?.details || {})
            .map(([key, value]) => `${key} ${value}`)
            .join(' ')
            .toLowerCase();
          return (
            String(item?.title || '').toLowerCase().includes(query) ||
            String(item?.tag || '').toLowerCase().includes(query) ||
            String(item?.title_header || '').toLowerCase().includes(query) ||
            detailsText.includes(query)
          );
        })
        .sort((a, b) => Date.parse(String(b?.created_at || '')) - Date.parse(String(a?.created_at || '')))
        .map((item) => serializeGalleryItemForFeed(item, userId));
      return json(res, 200, { items });
    }

    if (method === 'POST' && pathname === '/api/gallery') {
      const body = await readBody(req);
      const clean = normalizeGalleryItemPayload(body);
      const item = {
        id: store.galleryIdSeq++,
        ...clean,
      };
      store.galleryItems.push(item);
      saveStore(store);
      const userId = parsePositiveNumber(body?.user_id) || 0;
      return json(res, 201, { item: serializeGalleryItemForFeed(item, userId) });
    }

    if (method === 'DELETE' && /^\/api\/gallery\/\d+$/.test(pathname)) {
      const parts = pathname.split('/').filter(Boolean);
      const galleryId = parsePositiveNumber(parts[2]);
      if (!galleryId) return json(res, 400, { error: 'Invalid gallery id.' });
      const prevLen = store.galleryItems.length;
      store.galleryItems = store.galleryItems.filter((item) => Number(item.id) !== galleryId);
      if (store.galleryItems.length === prevLen) {
        return json(res, 404, { error: 'Gallery item not found.' });
      }
      store.galleryLikes = store.galleryLikes.filter((row) => Number(row.gallery_id) !== galleryId);
      store.galleryFavorites = store.galleryFavorites.filter((row) => Number(row.gallery_id) !== galleryId);
      store.galleryComments = store.galleryComments.filter((row) => Number(row.gallery_id) !== galleryId);
      saveStore(store);
      return json(res, 200, { ok: true });
    }

    if (method === 'POST' && /^\/api\/gallery\/\d+\/toggle-like$/.test(pathname)) {
      const parts = pathname.split('/').filter(Boolean);
      const galleryId = parsePositiveNumber(parts[2]);
      if (!galleryId) return json(res, 400, { error: 'Invalid gallery id.' });
      if (!getGalleryItemById(galleryId)) return json(res, 404, { error: 'Gallery item not found.' });
      const body = await readBody(req);
      const userId = parsePositiveNumber(body?.user_id);
      if (!userId) return json(res, 400, { error: 'user_id is required.' });
      const active = toggleGalleryReaction(store.galleryLikes, userId, galleryId);
      saveStore(store);
      return json(res, 200, { ok: true, active });
    }

    if (method === 'POST' && /^\/api\/gallery\/\d+\/toggle-favorite$/.test(pathname)) {
      const parts = pathname.split('/').filter(Boolean);
      const galleryId = parsePositiveNumber(parts[2]);
      if (!galleryId) return json(res, 400, { error: 'Invalid gallery id.' });
      if (!getGalleryItemById(galleryId)) return json(res, 404, { error: 'Gallery item not found.' });
      const body = await readBody(req);
      const userId = parsePositiveNumber(body?.user_id);
      if (!userId) return json(res, 400, { error: 'user_id is required.' });
      const active = toggleGalleryReaction(store.galleryFavorites, userId, galleryId);
      saveStore(store);
      return json(res, 200, { ok: true, active });
    }

    if (method === 'GET' && /^\/api\/gallery\/\d+\/comments$/.test(pathname)) {
      const parts = pathname.split('/').filter(Boolean);
      const galleryId = parsePositiveNumber(parts[2]);
      if (!galleryId) return json(res, 400, { error: 'Invalid gallery id.' });
      const comments = store.galleryComments
        .filter((row) => Number(row.gallery_id) === galleryId)
        .map((row) => {
          const identity = resolveCommentIdentity(row);
          return {
            ...row,
            user_id: identity.public_user_id || parsePositiveNumber(row.user_id) || 0,
            public_user_id: identity.public_user_id,
            nickname: identity.nickname,
            avatar_url: identity.avatar_url,
            parent_id: parsePositiveNumber(row.parent_id) || null,
          };
        })
        .sort((a, b) => Date.parse(String(a.created_at || '')) - Date.parse(String(b.created_at || '')));
      return json(res, 200, { comments });
    }

    if (method === 'POST' && /^\/api\/gallery\/\d+\/comments$/.test(pathname)) {
      const parts = pathname.split('/').filter(Boolean);
      const galleryId = parsePositiveNumber(parts[2]);
      if (!galleryId) return json(res, 400, { error: 'Invalid gallery id.' });
      if (!getGalleryItemById(galleryId)) return json(res, 404, { error: 'Gallery item not found.' });
      const body = await readBody(req);
      const clean = normalizeGalleryCommentPayload(body, galleryId);
      const identity = resolveCommentIdentity(clean);
      const comment = {
        id: store.galleryCommentIdSeq++,
        ...clean,
        user_id: identity.public_user_id || clean.user_id,
        public_user_id: identity.public_user_id,
        nickname: identity.nickname,
        avatar_url: identity.avatar_url,
        created_at: nowIso(),
      };
      store.galleryComments.push(comment);
      saveStore(store);
      return json(res, 201, { comment });
    }

    if (method === 'GET' && /^\/api\/movies\/\d+\/engagement$/.test(pathname)) {
      const parts = pathname.split('/').filter(Boolean);
      const tmdbId = parsePositiveNumber(parts[2]);
      if (!tmdbId) return json(res, 400, { error: 'Invalid tmdb id.' });
      const mediaType = normalizeMediaType(url.searchParams.get('media_type'));
      const counts = getMovieEngagementCounts(tmdbId, mediaType);
      return json(res, 200, { counts });
    }

    if (method === 'POST' && pathname === '/api/comments') {
      const body = await readBody(req);
      const clean = normalizeCommentInput(body);
      const identity = resolveCommentIdentity({
        ...clean,
        public_user_id: resolvePublicUserIdForNickname(clean.nickname, clean.user_id),
      });
      const comment = {
        id: store.commentIdSeq++,
        ...clean,
        user_id: identity.public_user_id || clean.user_id,
        public_user_id: identity.public_user_id,
        nickname: identity.nickname,
        avatar_url: identity.avatar_url,
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
        .map((c) => {
          const identity = resolveCommentIdentity(c);
          return {
            ...c,
            user_id: identity.public_user_id || parsePositiveNumber(c.user_id) || 0,
            public_user_id: identity.public_user_id,
            nickname: identity.nickname,
            avatar_url: identity.avatar_url,
          };
        })
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
