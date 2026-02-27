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
const dataFileBackup = `${dataFile}.bak`;
const CINEMA_POLL_TTL_MS = 12 * 60 * 60 * 1000;
const CLOUDINARY_GALLERY_TAG = 'movie_rec_gallery';
const CLOUDINARY_GALLERY_FOLDER = 'movie-rec-gallery';
const CLOUDINARY_STORE_TAG = 'movie_rec_store';
const CLOUDINARY_STORE_PUBLIC_ID = 'movie-rec-store/cinema-events';
const CLOUDINARY_STORE_FILENAME = 'cinema-events.json';
const CLOUDINARY_STORE_SYNC_DEBOUNCE_MS = 1200;
const EXPO_PUSH_SEND_URL = 'https://exp.host/--/api/v2/push/send';
const EXPO_PUSH_BATCH_SIZE = 100;
const LIVE_PUSH_CHECK_INTERVAL_MS = 15 * 1000;
const LOCAL_NICKNAME_RE = /^[a-zA-Z0-9._-]+$/;
const LOCAL_PASSWORD_MIN_LEN = 8;

function createEmptyStoreState() {
  return {
    store_updated_at: nowIso(),
    idSeq: 1,
    userIdSeq: 1,
    items: [],
    cinemaPollIdSeq: 1,
    cinemaPollCurrent: null,
    commentIdSeq: 1,
    comments: [],
    users: {},
    localAuth: {},
    userAliases: {},
    userSessions: {},
    follows: {},
    movieStates: {},
    galleryIdSeq: 1,
    galleryCommentIdSeq: 1,
    galleryItems: [],
    galleryLikes: [],
    galleryFavorites: [],
    galleryComments: [],
    pushTokenIdSeq: 1,
    pushTokens: [],
    pushState: {
      notified_live_event_ids: [],
      notified_poll_ids: [],
    },
  };
}

function ensureStore() {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(dataFile) && fs.existsSync(dataFileBackup)) {
    try {
      fs.copyFileSync(dataFileBackup, dataFile);
    } catch {
    }
  }
  if (!fs.existsSync(dataFile)) {
    fs.writeFileSync(dataFile, JSON.stringify(createEmptyStoreState(), null, 2), 'utf8');
  }
}

function hydrateStoreState(parsed) {
  const fallback = createEmptyStoreState();
  const galleryItemsRaw = Array.isArray(parsed?.galleryItems) ? parsed.galleryItems : [];
  const galleryItems = normalizeAndDedupeGalleryItems(galleryItemsRaw);
  const validGalleryIds = new Set(
    galleryItems
      .map((row) => parsePositiveNumber(row?.id))
      .filter((id) => !!id)
  );
  const galleryComments = (Array.isArray(parsed?.galleryComments) ? parsed.galleryComments : []).filter((row) =>
    validGalleryIds.has(parsePositiveNumber(row?.gallery_id))
  );
  const galleryLikes = dedupeByKey(
    (Array.isArray(parsed?.galleryLikes) ? parsed.galleryLikes : []).filter((row) =>
      validGalleryIds.has(parsePositiveNumber(row?.gallery_id))
    ),
    (row) => `${parsePositiveNumber(row?.user_id) || 0}:${parsePositiveNumber(row?.gallery_id) || 0}`
  );
  const galleryFavorites = dedupeByKey(
    (Array.isArray(parsed?.galleryFavorites) ? parsed.galleryFavorites : []).filter((row) =>
      validGalleryIds.has(parsePositiveNumber(row?.gallery_id))
    ),
    (row) => `${parsePositiveNumber(row?.user_id) || 0}:${parsePositiveNumber(row?.gallery_id) || 0}`
  );
  const usersState = parsed?.users && typeof parsed.users === 'object' ? parsed.users : {};
  const localAuthState = parsed?.localAuth && typeof parsed.localAuth === 'object' ? parsed.localAuth : {};
  const maxUserIdFromProfiles = Object.entries(usersState).reduce((acc, [rawKey, profile]) => {
    const idFromKey = parsePositiveNumber(rawKey) || 0;
    const idFromProfile = parsePositiveNumber(profile?.user_id) || 0;
    return Math.max(acc, idFromKey, idFromProfile);
  }, 0);
  const normalizeLocalAuthEntry = (rawRecord, fallbackUserId) => {
    if (!rawRecord || typeof rawRecord !== 'object') return null;
    const userId = parsePositiveNumber(rawRecord.user_id) || parsePositiveNumber(fallbackUserId);
    const nickname = normalizeText(rawRecord.nickname, 40);
    const passwordHash = String(rawRecord.password_hash || '').trim();
    if (!userId || !nickname || !passwordHash) return null;
    return {
      user_id: userId,
      nickname,
      nickname_key: nicknameKey(rawRecord.nickname_key || nickname),
      password_hash: passwordHash,
      created_at: normalizeIso(rawRecord.created_at, nowIso()),
      updated_at: normalizeIso(rawRecord.updated_at, nowIso()),
    };
  };
  const hydratedLocalAuth = Object.entries(localAuthState).reduce((acc, [rawKey, rawRecord]) => {
    const normalized = normalizeLocalAuthEntry(rawRecord, rawKey);
    if (!normalized) return acc;
    acc[String(normalized.user_id)] = normalized;
    return acc;
  }, {});
  const maxUserIdFromAuth = Object.values(hydratedLocalAuth).reduce(
    (acc, row) => Math.max(acc, parsePositiveNumber(row?.user_id) || 0),
    0
  );
  const pushTokens = Array.isArray(parsed?.pushTokens)
    ? parsed.pushTokens
        .map((row) => normalizePushTokenRecord(row))
        .filter(Boolean)
    : [];
  const pushState = normalizePushState(parsed?.pushState);
  return {
    store_updated_at: normalizeIso(parsed?.store_updated_at, nowIso()),
    idSeq: Number(parsed?.idSeq || 1),
    userIdSeq: Number(
      parsed?.userIdSeq ||
        (Math.max(maxUserIdFromProfiles, maxUserIdFromAuth, parsePositiveNumber(parsed?.userIdSeq) || 0) + 1) ||
        fallback.userIdSeq
    ),
    items: Array.isArray(parsed?.items) ? parsed.items : [],
    cinemaPollIdSeq: Number(parsed?.cinemaPollIdSeq || fallback.cinemaPollIdSeq),
    cinemaPollCurrent: normalizeCinemaPollState(parsed?.cinemaPollCurrent),
    commentIdSeq: Number(parsed?.commentIdSeq || 1),
    comments: Array.isArray(parsed?.comments) ? parsed.comments : [],
    users: usersState,
    localAuth: hydratedLocalAuth,
    userAliases: parsed?.userAliases && typeof parsed.userAliases === 'object' ? parsed.userAliases : {},
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
    galleryLikes,
    galleryFavorites,
    galleryComments,
    pushTokenIdSeq: Number(
      parsed?.pushTokenIdSeq ||
        (pushTokens.reduce((acc, row) => Math.max(acc, parsePositiveNumber(row?.id) || 0), 0) + 1) ||
        fallback.pushTokenIdSeq
    ),
    pushTokens,
    pushState,
  };
}

function parseStoreFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return hydrateStoreState(parsed);
  } catch {
    return null;
  }
}

function loadStore() {
  ensureStore();
  const primary = parseStoreFile(dataFile);
  if (primary) return primary;

  const backup = parseStoreFile(dataFileBackup);
  if (backup) {
    try {
      const tmpFile = `${dataFile}.${Date.now()}.tmp`;
      fs.writeFileSync(tmpFile, JSON.stringify(backup, null, 2), 'utf8');
      fs.renameSync(tmpFile, dataFile);
    } catch {
    }
    return backup;
  }
  return createEmptyStoreState();
}

function saveStoreLocallyOnly(store) {
  ensureStore();
  const serialized = JSON.stringify(store, null, 2);
  const tmpFile = `${dataFile}.${Date.now()}.tmp`;
  try {
    if (fs.existsSync(dataFile)) {
      fs.copyFileSync(dataFile, dataFileBackup);
    }
  } catch {
  }
  fs.writeFileSync(tmpFile, serialized, 'utf8');
  fs.renameSync(tmpFile, dataFile);
  try {
    fs.copyFileSync(dataFile, dataFileBackup);
  } catch {
  }
  return serialized;
}

function saveStore(store) {
  store.store_updated_at = nowIso();
  const serialized = saveStoreLocallyOnly(store);
  void scheduleCloudStoreSync(serialized);
}

let store = loadStore();

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

function normalizeCinemaPollOptionInput(input, index) {
  const optionIdRaw = normalizeText(input?.id, 20).toLowerCase();
  const optionId = optionIdRaw || `opt_${index + 1}`;
  const title = normalizeText(input?.title, 120);
  const posterUrl = normalizeImageUrl(input?.poster_url ?? input?.posterUrl);
  const tmdbId = parsePositiveNumber(input?.tmdb_id ?? input?.tmdbId);
  if (!title) throw new Error(`Poll option #${index + 1} title is required.`);
  if (!posterUrl) throw new Error(`Poll option #${index + 1} poster_url is required.`);
  return {
    id: optionId,
    title,
    poster_url: posterUrl,
    tmdb_id: tmdbId || null,
    votes: Math.max(0, Number(input?.votes) || 0),
  };
}

function normalizeCinemaPollInput(input) {
  const question = normalizeText(input?.question, 180) || 'Choose next movie';
  const optionsInput = Array.isArray(input?.options) ? input.options : [];
  if (optionsInput.length !== 3) {
    throw new Error('Cinema poll must contain exactly 3 options.');
  }
  const options = optionsInput.map((option, index) => normalizeCinemaPollOptionInput(option, index));
  const uniqueIds = new Set(options.map((option) => option.id));
  if (uniqueIds.size !== options.length) {
    throw new Error('Poll option ids must be unique.');
  }
  return {
    question,
    options,
  };
}

function normalizeCinemaPollState(input) {
  if (!input || typeof input !== 'object') return null;
  try {
    const question = normalizeText(input?.question, 180) || 'Choose next movie';
    const status = String(input?.status || '').toLowerCase() === 'closed' ? 'closed' : 'open';
    const optionsInput = Array.isArray(input?.options) ? input.options : [];
    if (optionsInput.length !== 3) return null;
    const options = optionsInput.map((option, index) => normalizeCinemaPollOptionInput(option, index));
    const rawVotesByUser = input?.votes_by_user && typeof input.votes_by_user === 'object' ? input.votes_by_user : {};
    const votesByUser = {};
    for (const [rawUserId, rawOptionId] of Object.entries(rawVotesByUser)) {
      const userId = parsePositiveNumber(rawUserId);
      if (!userId) continue;
      const optionId = normalizeText(rawOptionId, 20).toLowerCase();
      if (!optionId || !options.some((option) => option.id === optionId)) continue;
      votesByUser[String(userId)] = optionId;
    }
    const createdAt = normalizeIso(input?.created_at, nowIso());
    const normalized = {
      id: parsePositiveNumber(input?.id) || 1,
      question,
      status,
      options: options.map((option) => ({ ...option, votes: 0 })),
      votes_by_user: votesByUser,
      created_at: createdAt,
      updated_at: normalizeIso(input?.updated_at ?? input?.created_at, nowIso()),
      expires_at: normalizeIso(input?.expires_at, computeCinemaPollExpiresAt(createdAt)),
    };
    for (const optionId of Object.values(votesByUser)) {
      const option = normalized.options.find((row) => row.id === optionId);
      if (option) option.votes += 1;
    }
    if (normalized.status === 'open' && isCinemaPollExpired(normalized)) {
      normalized.status = 'closed';
      normalized.updated_at = nowIso();
    }
    return normalized;
  } catch {
    return null;
  }
}

function serializeCinemaPollForUser(poll, userIdInput) {
  if (!poll) return null;
  const userId = parsePositiveNumber(userIdInput);
  const totalVotes = poll.options.reduce((sum, option) => sum + Math.max(0, Number(option.votes) || 0), 0);
  const userVoteOptionId = userId ? String(poll.votes_by_user?.[String(userId)] || '') || null : null;
  return {
    id: Number(poll.id),
    question: poll.question,
    status: poll.status === 'closed' ? 'closed' : 'open',
    total_votes: totalVotes,
    user_vote_option_id: userVoteOptionId,
    options: poll.options.map((option) => {
      const votes = Math.max(0, Number(option.votes) || 0);
      const percent = totalVotes > 0 ? Math.round((votes / totalVotes) * 100) : 0;
      return {
        id: option.id,
        title: option.title,
        poster_url: option.poster_url,
        tmdb_id: option.tmdb_id ?? null,
        votes,
        percent,
      };
    }),
    created_at: poll.created_at,
    updated_at: poll.updated_at,
    expires_at: poll.expires_at,
  };
}

function computeCinemaPollExpiresAt(createdAtInput) {
  const createdAt = normalizeIso(createdAtInput, nowIso());
  const createdAtMs = Date.parse(createdAt);
  const expiresAtMs = Number.isFinite(createdAtMs) ? createdAtMs + CINEMA_POLL_TTL_MS : Date.now() + CINEMA_POLL_TTL_MS;
  return new Date(expiresAtMs).toISOString();
}

function isCinemaPollExpired(poll, nowMsInput = Date.now()) {
  if (!poll || poll.status !== 'open') return false;
  const expiresAtMs = Date.parse(String(poll.expires_at || ''));
  if (!Number.isFinite(expiresAtMs)) return false;
  const nowMs = Number.isFinite(Number(nowMsInput)) ? Number(nowMsInput) : Date.now();
  return nowMs >= expiresAtMs;
}

function closeExpiredCinemaPoll(nowMsInput = Date.now()) {
  const poll = store.cinemaPollCurrent;
  if (!poll || poll.status !== 'open') return false;
  if (!isCinemaPollExpired(poll, nowMsInput)) return false;
  poll.status = 'closed';
  poll.updated_at = nowIso();
  return true;
}

function createCinemaPoll(input) {
  const clean = normalizeCinemaPollInput(input);
  const createdAt = nowIso();
  const nextPoll = {
    id: store.cinemaPollIdSeq++,
    question: clean.question,
    status: 'open',
    options: clean.options.map((option) => ({ ...option, votes: 0 })),
    votes_by_user: {},
    created_at: createdAt,
    updated_at: createdAt,
    expires_at: computeCinemaPollExpiresAt(createdAt),
  };
  store.cinemaPollCurrent = nextPoll;
  return nextPoll;
}

function closeCinemaPoll(pollIdInput) {
  if (!store.cinemaPollCurrent) return null;
  const pollId = parsePositiveNumber(pollIdInput);
  if (pollId && Number(store.cinemaPollCurrent.id) !== pollId) {
    return null;
  }
  store.cinemaPollCurrent.status = 'closed';
  store.cinemaPollCurrent.updated_at = nowIso();
  return store.cinemaPollCurrent;
}

function voteCinemaPoll(pollIdInput, userIdInput, optionIdInput) {
  const poll = store.cinemaPollCurrent;
  if (!poll) throw new Error('No active cinema poll.');
  const pollId = parsePositiveNumber(pollIdInput);
  if (!pollId || pollId !== Number(poll.id)) throw new Error('Cinema poll not found.');
  if (isCinemaPollExpired(poll)) {
    poll.status = 'closed';
    poll.updated_at = nowIso();
    throw new Error('Cinema poll is closed.');
  }
  if (poll.status !== 'open') throw new Error('Cinema poll is closed.');

  const userId = parsePositiveNumber(userIdInput);
  if (!userId) throw new Error('user_id is required.');

  const optionId = normalizeText(optionIdInput, 20).toLowerCase();
  if (!optionId) throw new Error('option_id is required.');
  const selectedOption = poll.options.find((option) => option.id === optionId);
  if (!selectedOption) throw new Error('Invalid option_id.');

  const previousOptionId = String(poll.votes_by_user?.[String(userId)] || '').toLowerCase();
  if (previousOptionId) {
    if (previousOptionId === optionId) {
      return poll;
    }
    throw new Error('You already voted in this poll.');
  }

  selectedOption.votes += 1;

  poll.votes_by_user[String(userId)] = optionId;
  poll.updated_at = nowIso();
  return poll;
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
    watchlist: normalizeMovieList(body?.watchlist, 1200),
    favorites: normalizeMovieList(body?.favorites, 1200),
    watched: normalizeMovieList(body?.watched, 1200),
    rated: normalizeMovieRatings(body?.rated, 1200),
    favorite_actors: normalizePersonFavorites(body?.favorite_actors, 300),
    favorite_directors: normalizePersonFavorites(body?.favorite_directors, 300),
    updated_at: nowIso(),
  };
  return profile;
}

function publicProfileView(userId) {
  const canonicalUserId = resolveCanonicalUserId(userId);
  if (!canonicalUserId) return null;
  const profile = store.users[String(canonicalUserId)];
  if (!profile) return null;
  const movieState = store.movieStates[String(canonicalUserId)] ? ensureUserMovieState(canonicalUserId) : null;
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
  const favoriteActorsData = normalizePersonFavorites(profile.favorite_actors, 300);
  const favoriteDirectorsData = normalizePersonFavorites(profile.favorite_directors, 300);
  const followers = Object.values(store.follows).filter(
    (setLike) => Array.isArray(setLike) && setLike.includes(canonicalUserId)
  ).length;
  const following = Array.isArray(store.follows[String(canonicalUserId)])
    ? store.follows[String(canonicalUserId)].length
    : 0;
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
    favorite_actors: profile.privacy.favorite_actors ? favoriteActorsData : [],
    favorite_directors: profile.privacy.favorite_directors ? favoriteDirectorsData : [],
  };
}

function followUser(followerId, targetId) {
  const canonicalFollowerId = resolveCanonicalUserId(followerId);
  const canonicalTargetId = resolveCanonicalUserId(targetId);
  if (!canonicalFollowerId || !canonicalTargetId) throw new Error('Invalid follow target.');
  if (canonicalFollowerId === canonicalTargetId) throw new Error('Cannot follow yourself.');
  if (!store.users[String(canonicalTargetId)]) throw new Error('Target user not found.');
  const key = String(canonicalFollowerId);
  const current = Array.isArray(store.follows[key]) ? store.follows[key] : [];
  if (!current.includes(canonicalTargetId)) current.push(canonicalTargetId);
  store.follows[key] = current;
}

function unfollowUser(followerId, targetId) {
  const canonicalFollowerId = resolveCanonicalUserId(followerId);
  const canonicalTargetId = resolveCanonicalUserId(targetId);
  if (!canonicalFollowerId || !canonicalTargetId) return;
  const key = String(canonicalFollowerId);
  const current = Array.isArray(store.follows[key]) ? store.follows[key] : [];
  store.follows[key] = current.filter((id) => Number(id) !== Number(canonicalTargetId));
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
  const canonicalUserId = resolveCanonicalUserIdForNickname(userId, nickname) || parsePositiveNumber(userId);
  if (!canonicalUserId) throw new Error('user_id is required.');
  return {
    user_id: canonicalUserId,
    tmdb_id: tmdbId,
    text: text.slice(0, 1000),
    nickname,
    parent_id: parentId,
    avatar_url: avatarUrl,
  };
}

function resolvePublicUserIdForNickname(nickname, fallbackUserId) {
  return resolveCanonicalUserIdForNickname(fallbackUserId, nickname) || parsePositiveNumber(fallbackUserId) || null;
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

function normalizeExpoPushToken(input) {
  const token = String(input || '').trim();
  if (!token) return '';
  if (/^(ExponentPushToken|ExpoPushToken)\[[^\]]+\]$/.test(token)) return token;
  return '';
}

function normalizePushTokenRecord(row) {
  if (!row || typeof row !== 'object') return null;
  const userId = parsePositiveNumber(row.user_id);
  const token = normalizeExpoPushToken(row.expo_push_token || row.token);
  if (!userId || !token) return null;
  const id = parsePositiveNumber(row.id) || null;
  const platform = normalizeText(row.platform, 30) || 'unknown';
  const deviceName = normalizeText(row.device_name, 120) || null;
  const createdAt = normalizeIso(row.created_at, nowIso());
  const updatedAt = normalizeIso(row.updated_at, createdAt);
  return {
    id,
    user_id: userId,
    expo_push_token: token,
    platform,
    device_name: deviceName,
    created_at: createdAt,
    updated_at: updatedAt,
    last_error: normalizeText(row.last_error, 300) || null,
  };
}

function normalizePushState(raw) {
  const state = raw && typeof raw === 'object' ? raw : {};
  const normalizeList = (value) =>
    Array.from(
      new Set(
        (Array.isArray(value) ? value : [])
          .map((id) => parsePositiveNumber(id))
          .filter((id) => !!id)
      )
    );
  return {
    notified_live_event_ids: normalizeList(state.notified_live_event_ids),
    notified_poll_ids: normalizeList(state.notified_poll_ids),
  };
}

function ensurePushStores() {
  if (!Array.isArray(store.pushTokens)) {
    store.pushTokens = [];
  }
  store.pushState = normalizePushState(store.pushState);
  const maxPushTokenId = store.pushTokens.reduce((acc, row) => {
    return Math.max(acc, parsePositiveNumber(row?.id) || 0);
  }, 0);
  const nextSeq = parsePositiveNumber(store.pushTokenIdSeq) || maxPushTokenId + 1 || 1;
  store.pushTokenIdSeq = Math.max(1, nextSeq, maxPushTokenId + 1);
}

function appendUniqueCapped(listInput, idInput, maxSize = 800) {
  const id = parsePositiveNumber(idInput);
  if (!id) return listInput;
  const list = Array.isArray(listInput) ? listInput : [];
  if (!list.includes(id)) list.push(id);
  while (list.length > maxSize) list.shift();
  return list;
}

function upsertPushTokenRecord({ userId, expoPushToken, platform, deviceName }) {
  const canonicalUserId = resolveCanonicalUserId(userId) || parsePositiveNumber(userId);
  const token = normalizeExpoPushToken(expoPushToken);
  if (!canonicalUserId || !token) return null;
  ensurePushStores();

  const now = nowIso();
  let reusedId = null;
  let createdAt = now;

  store.pushTokens = store.pushTokens.filter((row) => {
    const normalized = normalizePushTokenRecord(row);
    if (!normalized) return false;
    if (normalized.expo_push_token !== token) return true;
    reusedId = parsePositiveNumber(normalized.id) || reusedId;
    createdAt = normalized.created_at || createdAt;
    return false;
  });

  const id = reusedId || parsePositiveNumber(store.pushTokenIdSeq) || 1;
  store.pushTokenIdSeq = Math.max(parsePositiveNumber(store.pushTokenIdSeq) || 1, id + 1);

  const record = {
    id,
    user_id: canonicalUserId,
    expo_push_token: token,
    platform: normalizeText(platform, 30) || 'unknown',
    device_name: normalizeText(deviceName, 120) || null,
    created_at: normalizeIso(createdAt, now),
    updated_at: now,
    last_error: null,
  };
  store.pushTokens.push(record);
  return record;
}

function removePushTokenRecord(userIdInput, tokenInput) {
  const token = normalizeExpoPushToken(tokenInput);
  if (!token) return 0;
  const canonicalUserId = resolveCanonicalUserId(userIdInput) || parsePositiveNumber(userIdInput);
  ensurePushStores();
  const before = store.pushTokens.length;
  store.pushTokens = store.pushTokens.filter((row) => {
    const normalized = normalizePushTokenRecord(row);
    if (!normalized) return false;
    if (normalized.expo_push_token !== token) return true;
    if (canonicalUserId && normalized.user_id !== canonicalUserId) return true;
    return false;
  });
  return Math.max(0, before - store.pushTokens.length);
}

function removePushTokensForUsers(userIdsInput) {
  const userIds = new Set(
    (Array.isArray(userIdsInput) ? userIdsInput : [])
      .map((id) => resolveCanonicalUserId(id) || parsePositiveNumber(id))
      .filter((id) => !!id)
  );
  if (!userIds.size) return 0;
  ensurePushStores();
  const before = store.pushTokens.length;
  store.pushTokens = store.pushTokens.filter((row) => {
    const normalized = normalizePushTokenRecord(row);
    if (!normalized) return false;
    return !userIds.has(normalized.user_id);
  });
  return Math.max(0, before - store.pushTokens.length);
}

function markPushTokenError(tokenInput, errorInput) {
  const token = normalizeExpoPushToken(tokenInput);
  if (!token) return;
  const message = normalizeText(errorInput, 300) || 'Unknown push error.';
  const now = nowIso();
  ensurePushStores();
  for (const row of store.pushTokens) {
    if (normalizeExpoPushToken(row?.expo_push_token) !== token) continue;
    row.last_error = message;
    row.updated_at = now;
  }
}

function clearPushTokenError(tokenInput) {
  const token = normalizeExpoPushToken(tokenInput);
  if (!token) return;
  const now = nowIso();
  ensurePushStores();
  for (const row of store.pushTokens) {
    if (normalizeExpoPushToken(row?.expo_push_token) !== token) continue;
    row.last_error = null;
    row.updated_at = now;
  }
}

function collectExpoPushTokensForUsers(userIdsInput) {
  ensurePushStores();
  const canonicalIds = new Set();
  for (const rawId of Array.isArray(userIdsInput) ? userIdsInput : []) {
    const canonical = resolveCanonicalUserId(rawId) || parsePositiveNumber(rawId);
    if (!canonical) continue;
    canonicalIds.add(canonical);
    for (const aliasId of getAliasUserIdsForCanonical(canonical)) {
      const aliasCanonical = resolveCanonicalUserId(aliasId) || parsePositiveNumber(aliasId);
      if (aliasCanonical) canonicalIds.add(aliasCanonical);
    }
  }
  if (!canonicalIds.size) return [];
  const tokenSet = new Set();
  for (const row of store.pushTokens) {
    const normalized = normalizePushTokenRecord(row);
    if (!normalized) continue;
    if (!canonicalIds.has(normalized.user_id)) continue;
    tokenSet.add(normalized.expo_push_token);
  }
  return Array.from(tokenSet);
}

function collectExpoPushTokensForAllUsers() {
  ensurePushStores();
  const tokenSet = new Set();
  for (const row of store.pushTokens) {
    const normalized = normalizePushTokenRecord(row);
    if (!normalized) continue;
    tokenSet.add(normalized.expo_push_token);
  }
  return Array.from(tokenSet);
}

function buildExpoPushMessages(tokensInput, payloadInput = {}) {
  const tokens = Array.isArray(tokensInput) ? tokensInput : [];
  const title = normalizeText(payloadInput.title, 120) || 'Movie Rec';
  const body = normalizeText(payloadInput.body, 240) || 'Open app.';
  const data =
    payloadInput.data && typeof payloadInput.data === 'object'
      ? payloadInput.data
      : {};
  return tokens
    .map((token) => normalizeExpoPushToken(token))
    .filter((token) => !!token)
    .map((token) => ({
      to: token,
      sound: 'default',
      title,
      body,
      data,
      priority: 'high',
      channelId: 'default',
    }));
}

async function sendExpoPushMessages(messagesInput) {
  const messages = Array.isArray(messagesInput) ? messagesInput.filter((row) => !!normalizeExpoPushToken(row?.to)) : [];
  if (!messages.length) return { sent: 0, errors: 0, removed: 0 };

  let sent = 0;
  let errors = 0;
  let removed = 0;

  for (let idx = 0; idx < messages.length; idx += EXPO_PUSH_BATCH_SIZE) {
    const batch = messages.slice(idx, idx + EXPO_PUSH_BATCH_SIZE);
    let response = null;
    try {
      response = await fetch(EXPO_PUSH_SEND_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify(batch),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      for (const row of batch) {
        markPushTokenError(row.to, message);
        errors += 1;
      }
      continue;
    }

    if (!response || !response.ok) {
      const message = `Expo push HTTP ${response ? response.status : 0}`;
      for (const row of batch) {
        markPushTokenError(row.to, message);
        errors += 1;
      }
      continue;
    }

    const payload = await response.json().catch(() => null);
    const tickets = Array.isArray(payload?.data) ? payload.data : [];
    for (let ticketIdx = 0; ticketIdx < batch.length; ticketIdx += 1) {
      const ticket = tickets[ticketIdx] || null;
      const row = batch[ticketIdx];
      const token = normalizeExpoPushToken(row?.to);
      if (!token) continue;
      if (ticket?.status === 'ok') {
        clearPushTokenError(token);
        sent += 1;
        continue;
      }

      const expoErrorCode = normalizeText(ticket?.details?.error, 120);
      const errorMessage =
        normalizeText(ticket?.message, 280) ||
        normalizeText(ticket?.error, 280) ||
        normalizeText(expoErrorCode, 280) ||
        'Expo push rejected message.';
      markPushTokenError(token, errorMessage);
      errors += 1;

      if (expoErrorCode === 'DeviceNotRegistered') {
        removed += removePushTokenRecord(null, token);
      }
    }
  }

  return { sent, errors, removed };
}

async function pushNotifyUsers(userIdsInput, payloadInput) {
  const tokens = collectExpoPushTokensForUsers(userIdsInput);
  if (!tokens.length) return { sent: 0, errors: 0, removed: 0 };
  const messages = buildExpoPushMessages(tokens, payloadInput);
  return sendExpoPushMessages(messages);
}

async function pushNotifyAllUsers(payloadInput) {
  const tokens = collectExpoPushTokensForAllUsers();
  if (!tokens.length) return { sent: 0, errors: 0, removed: 0 };
  const messages = buildExpoPushMessages(tokens, payloadInput);
  return sendExpoPushMessages(messages);
}

async function notifyCinemaPollOpenedPush(pollInput) {
  const pollId = parsePositiveNumber(pollInput?.id);
  if (!pollId) return false;
  if (String(pollInput?.status || 'open') !== 'open') return false;
  ensurePushStores();
  if (store.pushState.notified_poll_ids.includes(pollId)) return false;

  const result = await pushNotifyAllUsers({
    title: 'New cinema poll is open',
    body: normalizeText(pollInput?.question, 180) || 'Vote now and pick the next stream title.',
    data: {
      type: 'cinema_poll_open',
      pollId,
      actionPath: '/cinema',
    },
  });
  console.log(
    `[push] poll_open id=${pollId} sent=${Number(result?.sent || 0)} errors=${Number(result?.errors || 0)} removed=${Number(result?.removed || 0)}`
  );

  store.pushState.notified_poll_ids = appendUniqueCapped(store.pushState.notified_poll_ids, pollId, 500);
  return true;
}

function getLiveCinemaEvent(nowMsInput = Date.now()) {
  const nowMs = Number.isFinite(Number(nowMsInput)) ? Number(nowMsInput) : Date.now();
  const candidates = (Array.isArray(store.items) ? store.items : [])
    .filter((item) => {
      const id = parsePositiveNumber(item?.id);
      const startAt = Date.parse(String(item?.start_at || ''));
      const endAt = Date.parse(String(item?.end_at || ''));
      if (!id || !Number.isFinite(startAt) || !Number.isFinite(endAt)) return false;
      return startAt <= nowMs && endAt >= nowMs;
    })
    .sort((a, b) => Date.parse(String(b?.start_at || '')) - Date.parse(String(a?.start_at || '')));
  return candidates[0] || null;
}

async function notifyCinemaLiveStartedPushIfNeeded() {
  const liveEvent = getLiveCinemaEvent(Date.now());
  if (!liveEvent) return false;
  const liveEventId = parsePositiveNumber(liveEvent?.id);
  if (!liveEventId) return false;
  ensurePushStores();
  if (store.pushState.notified_live_event_ids.includes(liveEventId)) return false;

  const result = await pushNotifyAllUsers({
    title: `${normalizeText(liveEvent?.title, 90) || 'Cinema'} is live now`,
    body: 'Tap to join the stream.',
    data: {
      type: 'cinema_live_start',
      eventId: liveEventId,
      actionPath: '/cinema',
    },
  });
  console.log(
    `[push] live_start event=${liveEventId} sent=${Number(result?.sent || 0)} errors=${Number(result?.errors || 0)} removed=${Number(result?.removed || 0)}`
  );

  store.pushState.notified_live_event_ids = appendUniqueCapped(store.pushState.notified_live_event_ids, liveEventId, 500);
  return true;
}

function resolveReplyPushTargetUserId(parentRow) {
  if (!parentRow || typeof parentRow !== 'object') return null;
  const identity = resolveCommentIdentity(parentRow);
  return parsePositiveNumber(identity?.public_user_id || parentRow?.user_id);
}

async function notifyCommentReplyPush(source, replyRow, parentRow) {
  const sourceType = source === 'gallery' ? 'gallery' : 'movie';
  const targetUserId = resolveReplyPushTargetUserId(parentRow);
  const actorIdentity = resolveCommentIdentity(replyRow);
  const actorUserId = parsePositiveNumber(actorIdentity?.public_user_id || replyRow?.user_id);
  if (!targetUserId || !actorUserId || actorUserId === targetUserId) return false;

  const galleryId = parsePositiveNumber(replyRow?.gallery_id);
  const tmdbId = parsePositiveNumber(replyRow?.tmdb_id);
  const parentId = parsePositiveNumber(parentRow?.id);
  const replyId = parsePositiveNumber(replyRow?.id);
  let movieReplyPath = '/';
  if (tmdbId) {
    const query = new URLSearchParams();
    query.set('openComments', '1');
    if (parentId) query.set('focusParent', String(parentId));
    if (replyId) query.set('focusReply', String(replyId));
    movieReplyPath = `/movie/${tmdbId}?${query.toString()}`;
  }
  const actionPath =
    sourceType === 'gallery'
      ? galleryId
        ? `/gallery?open=${galleryId}`
        : '/gallery'
      : tmdbId
        ? movieReplyPath
        : '/';
  const text = normalizeText(replyRow?.text, 160) || 'Open app to view the reply.';

  await pushNotifyUsers([targetUserId], {
    title: `${normalizeText(actorIdentity?.nickname, 80) || 'Someone'} replied to your comment`,
    body: text,
    data: {
      type: 'comment_reply',
      source: sourceType,
      replyId: parsePositiveNumber(replyRow?.id) || 0,
      parentId: parsePositiveNumber(parentRow?.id) || 0,
      actionPath,
    },
  });
  return true;
}

function ensureUserAliasesStore() {
  if (!store.userAliases || typeof store.userAliases !== 'object') {
    store.userAliases = {};
  }
  return store.userAliases;
}

function nicknameKey(value) {
  return String(value || '').trim().toLowerCase();
}

function resolveCanonicalUserId(userIdInput) {
  let userId = parsePositiveNumber(userIdInput);
  if (!userId) return null;
  const aliases = ensureUserAliasesStore();
  const visited = [];
  const seen = new Set();
  while (!seen.has(userId)) {
    seen.add(userId);
    const aliasTarget = parsePositiveNumber(aliases[String(userId)]);
    if (!aliasTarget || aliasTarget === userId) break;
    visited.push(userId);
    userId = aliasTarget;
  }
  for (const aliasId of visited) {
    aliases[String(aliasId)] = userId;
  }
  return userId;
}

function setUserAlias(aliasIdInput, canonicalIdInput) {
  const aliasId = parsePositiveNumber(aliasIdInput);
  const canonicalId = resolveCanonicalUserId(canonicalIdInput);
  if (!aliasId || !canonicalId) return null;
  if (aliasId === canonicalId) return canonicalId;
  const aliases = ensureUserAliasesStore();
  aliases[String(aliasId)] = canonicalId;
  for (const [rawId, rawTarget] of Object.entries(aliases)) {
    const id = parsePositiveNumber(rawId);
    const target = parsePositiveNumber(rawTarget);
    if (!id || !target || id === canonicalId) continue;
    if (target === aliasId) aliases[String(id)] = canonicalId;
  }
  return canonicalId;
}

function ensureLocalAuthStore() {
  if (!store.localAuth || typeof store.localAuth !== 'object') {
    store.localAuth = {};
  }
  return store.localAuth;
}

function validateLocalNickname(nicknameInput) {
  const nickname = normalizeText(nicknameInput, 40);
  if (!nickname) throw new Error('nickname is required.');
  if (nickname.length < 3 || nickname.length > 20) {
    throw new Error('Nickname must be 3-20 characters.');
  }
  if (!LOCAL_NICKNAME_RE.test(nickname)) {
    throw new Error('Nickname can contain only letters, numbers, ".", "_" or "-".');
  }
  return nickname;
}

function validateLocalPassword(passwordInput) {
  const password = String(passwordInput || '');
  if (!password) throw new Error('password is required.');
  if (password.length < LOCAL_PASSWORD_MIN_LEN) {
    throw new Error(`Password must be at least ${LOCAL_PASSWORD_MIN_LEN} characters.`);
  }
  return password;
}

function hashLocalPassword(passwordInput) {
  return crypto.createHash('sha256').update(String(passwordInput || '')).digest('hex');
}

function allocateCanonicalUserId() {
  const fromProfiles = Object.entries(store.users || {}).reduce((acc, [rawUserId, profile]) => {
    const idFromKey = parsePositiveNumber(rawUserId) || 0;
    const idFromProfile = parsePositiveNumber(profile?.user_id) || 0;
    return Math.max(acc, idFromKey, idFromProfile);
  }, 0);
  const fromAuth = Object.entries(ensureLocalAuthStore()).reduce((acc, [rawUserId, row]) => {
    const idFromKey = parsePositiveNumber(rawUserId) || 0;
    const idFromRow = parsePositiveNumber(row?.user_id) || 0;
    return Math.max(acc, idFromKey, idFromRow);
  }, 0);
  const fromAliases = Object.entries(store.userAliases || {}).reduce((acc, [rawAliasId, rawTargetId]) => {
    const aliasId = parsePositiveNumber(rawAliasId) || 0;
    const targetId = parsePositiveNumber(rawTargetId) || 0;
    return Math.max(acc, aliasId, targetId);
  }, 0);
  const next = Math.max(
    1,
    parsePositiveNumber(store.userIdSeq) || 1,
    fromProfiles + 1,
    fromAuth + 1,
    fromAliases + 1
  );
  store.userIdSeq = next + 1;
  return next;
}

function getLocalAuthEntryByUserId(userIdInput) {
  const userId = resolveCanonicalUserId(userIdInput) || parsePositiveNumber(userIdInput);
  if (!userId) return null;
  const row = ensureLocalAuthStore()[String(userId)];
  if (!row || typeof row !== 'object') return null;
  const nickname = normalizeText(row.nickname, 40);
  const passwordHash = String(row.password_hash || '').trim();
  if (!nickname || !passwordHash) return null;
  return {
    user_id: userId,
    nickname,
    nickname_key: nicknameKey(row.nickname_key || nickname),
    password_hash: passwordHash,
    created_at: normalizeIso(row.created_at, nowIso()),
    updated_at: normalizeIso(row.updated_at, nowIso()),
  };
}

function findLocalAuthEntryByNickname(nicknameInput) {
  const clean = nicknameKey(nicknameInput);
  if (!clean) return null;
  const rows = Object.entries(ensureLocalAuthStore());
  for (const [rawUserId, row] of rows) {
    const userId = resolveCanonicalUserId(row?.user_id) || resolveCanonicalUserId(rawUserId) || parsePositiveNumber(rawUserId);
    const nickname = normalizeText(row?.nickname, 40);
    const passwordHash = String(row?.password_hash || '').trim();
    const rowNickKey = nicknameKey(row?.nickname_key || nickname);
    if (!userId || !nickname || !passwordHash) continue;
    if (rowNickKey !== clean) continue;
    return {
      user_id: userId,
      nickname,
      nickname_key: rowNickKey,
      password_hash: passwordHash,
      created_at: normalizeIso(row?.created_at, nowIso()),
      updated_at: normalizeIso(row?.updated_at, nowIso()),
    };
  }
  return null;
}

function upsertLocalAuthEntry(
  userIdInput,
  nicknameInput,
  passwordInput,
  options = { passwordAlreadyHashed: false }
) {
  const canonicalUserId = resolveCanonicalUserId(userIdInput) || parsePositiveNumber(userIdInput);
  if (!canonicalUserId) throw new Error('Invalid user id.');
  const nickname = validateLocalNickname(nicknameInput);
  const passwordHash = options?.passwordAlreadyHashed
    ? String(passwordInput || '').trim()
    : hashLocalPassword(validateLocalPassword(passwordInput));
  if (!passwordHash) throw new Error('password is required.');
  const takenByNickname = findLocalAuthEntryByNickname(nickname);
  if (takenByNickname && takenByNickname.user_id !== canonicalUserId) {
    throw new Error('Nickname already used.');
  }
  const localAuth = ensureLocalAuthStore();
  const existing = getLocalAuthEntryByUserId(canonicalUserId);
  const now = nowIso();
  const next = {
    user_id: canonicalUserId,
    nickname,
    nickname_key: nicknameKey(nickname),
    password_hash: passwordHash,
    created_at: existing?.created_at || now,
    updated_at: now,
  };
  localAuth[String(canonicalUserId)] = next;
  return next;
}

function syncLocalAuthNicknameForUser(userIdInput, nicknameInput) {
  const canonicalUserId = resolveCanonicalUserId(userIdInput) || parsePositiveNumber(userIdInput);
  if (!canonicalUserId) return null;
  const existing = getLocalAuthEntryByUserId(canonicalUserId);
  if (!existing) return null;
  const nickname = normalizeText(nicknameInput, 40);
  if (!nickname) return existing;
  const takenByNickname = findLocalAuthEntryByNickname(nickname);
  if (takenByNickname && takenByNickname.user_id !== canonicalUserId) {
    return existing;
  }
  const localAuth = ensureLocalAuthStore();
  localAuth[String(canonicalUserId)] = {
    ...existing,
    nickname,
    nickname_key: nicknameKey(nickname),
    updated_at: nowIso(),
  };
  return localAuth[String(canonicalUserId)];
}

function maintainLocalAuthMappings() {
  const source = ensureLocalAuthStore();
  const normalizedByUser = {};
  const sortedRows = Object.entries(source).sort(([a], [b]) => (parsePositiveNumber(a) || 0) - (parsePositiveNumber(b) || 0));
  for (const [rawUserId, row] of sortedRows) {
    const canonicalUserId =
      resolveCanonicalUserId(row?.user_id) || resolveCanonicalUserId(rawUserId) || parsePositiveNumber(rawUserId);
    const nickname = normalizeText(row?.nickname, 40);
    const passwordHash = String(row?.password_hash || '').trim();
    if (!canonicalUserId || !nickname || !passwordHash) continue;
    const candidate = {
      user_id: canonicalUserId,
      nickname,
      nickname_key: nicknameKey(row?.nickname_key || nickname),
      password_hash: passwordHash,
      created_at: normalizeIso(row?.created_at, nowIso()),
      updated_at: normalizeIso(row?.updated_at, nowIso()),
    };
    const existing = normalizedByUser[String(canonicalUserId)];
    if (!existing || Date.parse(String(candidate.updated_at || '')) >= Date.parse(String(existing.updated_at || ''))) {
      normalizedByUser[String(canonicalUserId)] = candidate;
    }
  }
  const nicknameOwner = new Map();
  const deduped = {};
  const ordered = Object.values(normalizedByUser).sort(
    (a, b) => Date.parse(String(b.updated_at || '')) - Date.parse(String(a.updated_at || ''))
  );
  for (const row of ordered) {
    const key = nicknameKey(row.nickname_key || row.nickname);
    if (!key) continue;
    const ownedBy = nicknameOwner.get(key);
    if (ownedBy && ownedBy !== row.user_id) {
      continue;
    }
    nicknameOwner.set(key, row.user_id);
    deduped[String(row.user_id)] = {
      ...row,
      nickname_key: key,
    };
  }
  store.localAuth = deduped;
}

function serializeLocalAuthUser(userIdInput) {
  const canonicalUserId = resolveCanonicalUserId(userIdInput) || parsePositiveNumber(userIdInput);
  if (!canonicalUserId) return null;
  const auth = getLocalAuthEntryByUserId(canonicalUserId);
  const profile = ensureUserProfile(canonicalUserId, auth?.nickname || null);
  if (!profile) return null;
  const nickname = normalizeText(auth?.nickname, 40) || normalizeText(profile.nickname, 40) || `user_${canonicalUserId}`;
  profile.nickname = nickname;
  profile.user_id = canonicalUserId;
  profile.updated_at = normalizeIso(profile.updated_at, nowIso());
  return {
    user_id: canonicalUserId,
    nickname,
    name: normalizeText(profile.name, 80) || null,
    email: null,
    date_of_birth: null,
    country: null,
    bio: normalizeText(profile.bio, 300) || null,
    avatar_url: normalizeAvatarUrl(profile.avatar_url),
    role: nicknameKey(nickname) === 'admin' ? 'admin' : 'user',
    auth_provider: 'local',
    created_at: auth?.created_at || nowIso(),
    updated_at: normalizeIso(profile.updated_at, nowIso()),
  };
}

function dedupeByKey(rows, keySelector) {
  const map = new Map();
  for (const row of rows) {
    const key = keySelector(row);
    if (!key) continue;
    map.set(String(key), row);
  }
  return Array.from(map.values());
}

function mergeUserProfiles(primaryProfile, secondaryProfile, canonicalUserId) {
  const primary = primaryProfile && typeof primaryProfile === 'object' ? primaryProfile : {};
  const secondary = secondaryProfile && typeof secondaryProfile === 'object' ? secondaryProfile : {};
  const watchlistSource = Array.isArray(primary.watchlist)
    ? primary.watchlist
    : Array.isArray(secondary.watchlist)
      ? secondary.watchlist
      : [];
  const favoritesSource = Array.isArray(primary.favorites)
    ? primary.favorites
    : Array.isArray(secondary.favorites)
      ? secondary.favorites
      : [];
  const watchedSource = Array.isArray(primary.watched)
    ? primary.watched
    : Array.isArray(secondary.watched)
      ? secondary.watched
      : [];
  const ratedSource = Array.isArray(primary.rated)
    ? primary.rated
    : Array.isArray(secondary.rated)
      ? secondary.rated
      : [];
  const favoriteActorsSource = Array.isArray(primary.favorite_actors)
    ? primary.favorite_actors
    : Array.isArray(secondary.favorite_actors)
      ? secondary.favorite_actors
      : [];
  const favoriteDirectorsSource = Array.isArray(primary.favorite_directors)
    ? primary.favorite_directors
    : Array.isArray(secondary.favorite_directors)
      ? secondary.favorite_directors
      : [];
  const merged = {
    ...secondary,
    ...primary,
    user_id: canonicalUserId,
    nickname: normalizeText(primary.nickname, 40) || normalizeText(secondary.nickname, 40) || `user_${canonicalUserId}`,
    name: normalizeText(primary.name, 80) || normalizeText(secondary.name, 80) || null,
    bio: normalizeText(primary.bio, 300) || normalizeText(secondary.bio, 300) || null,
    avatar_url: normalizeAvatarUrl(primary.avatar_url) || normalizeAvatarUrl(secondary.avatar_url) || null,
    privacy: {
      watchlist: !!(primary.privacy?.watchlist ?? secondary.privacy?.watchlist),
      favorites: !!(primary.privacy?.favorites ?? secondary.privacy?.favorites),
      watched: !!(primary.privacy?.watched ?? secondary.privacy?.watched),
      rated: !!(primary.privacy?.rated ?? secondary.privacy?.rated),
      favorite_actors: !!(primary.privacy?.favorite_actors ?? secondary.privacy?.favorite_actors),
      favorite_directors: !!(primary.privacy?.favorite_directors ?? secondary.privacy?.favorite_directors),
    },
    watchlist: normalizeMovieList(watchlistSource, 1200),
    favorites: normalizeMovieList(favoritesSource, 1200),
    watched: normalizeMovieList(watchedSource, 1200),
    rated: normalizeMovieRatings(ratedSource, 1200),
    favorite_actors: normalizePersonFavorites(favoriteActorsSource, 300),
    favorite_directors: normalizePersonFavorites(favoriteDirectorsSource, 300),
    updated_at: normalizeIso(primary.updated_at ?? secondary.updated_at, nowIso()),
  };
  return merged;
}

function mergeUserMovieStates(canonicalUserId, aliasUserId) {
  if (!canonicalUserId || !aliasUserId || canonicalUserId === aliasUserId) return;
  const canonicalKey = String(canonicalUserId);
  const aliasKey = String(aliasUserId);
  const canonicalState = store.movieStates[canonicalKey];
  const aliasState = store.movieStates[aliasKey];
  if (!aliasState && !canonicalState) return;

  const base = ensureUserMovieState(canonicalUserId);
  const alias =
    aliasState && typeof aliasState === 'object'
      ? {
          privacy: normalizeMoviePrivacy(aliasState.privacy, DEFAULT_MOVIE_PRIVACY),
          watchlist: normalizeMovieList(aliasState.watchlist, 1200),
          favorites: normalizeMovieList(aliasState.favorites, 1200),
          watched: normalizeMovieList(aliasState.watched, 1200),
          ratings: normalizeMovieRatings(aliasState.ratings, 1200),
        }
      : null;
  if (alias) {
    base.watchlist = normalizeMovieList([...(alias.watchlist || []), ...(base.watchlist || [])], 1200);
    base.favorites = normalizeMovieList([...(alias.favorites || []), ...(base.favorites || [])], 1200);
    base.watched = normalizeMovieList([...(alias.watched || []), ...(base.watched || [])], 1200);
    base.ratings = normalizeMovieRatings([...(alias.ratings || []), ...(base.ratings || [])], 1200);
    base.privacy = normalizeMoviePrivacy(
      {
        watchlist: !!alias.privacy?.watchlist || !!base.privacy?.watchlist,
        favorites: !!alias.privacy?.favorites || !!base.privacy?.favorites,
        watched: !!alias.privacy?.watched || !!base.privacy?.watched,
        rated: !!alias.privacy?.rated || !!base.privacy?.rated,
      },
      base.privacy
    );
    base.updated_at = nowIso();
    delete store.movieStates[aliasKey];
  }
  store.movieStates[canonicalKey] = base;
}

function remapFollowsToCanonicalIds() {
  const next = {};
  for (const [rawFollowerId, rawTargets] of Object.entries(store.follows || {})) {
    const followerId = resolveCanonicalUserId(rawFollowerId);
    if (!followerId) continue;
    const currentTargets = Array.isArray(next[String(followerId)]) ? next[String(followerId)] : [];
    const targetSet = new Set(currentTargets.map((x) => Number(x)));
    for (const rawTarget of Array.isArray(rawTargets) ? rawTargets : []) {
      const targetId = resolveCanonicalUserId(rawTarget);
      if (!targetId || targetId === followerId) continue;
      targetSet.add(targetId);
    }
    next[String(followerId)] = Array.from(targetSet);
  }
  store.follows = next;
}

function mergeUserIntoCanonicalUserId(aliasUserIdInput, canonicalUserIdInput) {
  const aliasUserId = parsePositiveNumber(aliasUserIdInput);
  const canonicalUserId = resolveCanonicalUserId(canonicalUserIdInput) || parsePositiveNumber(canonicalUserIdInput);
  if (!aliasUserId || !canonicalUserId) return canonicalUserId || aliasUserId || null;
  if (aliasUserId === canonicalUserId) return canonicalUserId;

  setUserAlias(aliasUserId, canonicalUserId);

  const aliasProfile = store.users[String(aliasUserId)];
  const canonicalProfile = store.users[String(canonicalUserId)];
  if (aliasProfile || canonicalProfile) {
    store.users[String(canonicalUserId)] = mergeUserProfiles(canonicalProfile, aliasProfile, canonicalUserId);
    if (aliasUserId !== canonicalUserId) {
      delete store.users[String(aliasUserId)];
    }
  }

  const aliasAuth = getLocalAuthEntryByUserId(aliasUserId);
  const canonicalAuth = getLocalAuthEntryByUserId(canonicalUserId);
  if (aliasAuth || canonicalAuth) {
    const localAuth = ensureLocalAuthStore();
    const sourceAuth = [canonicalAuth, aliasAuth]
      .filter((row) => !!row)
      .sort((a, b) => Date.parse(String(b.updated_at || '')) - Date.parse(String(a.updated_at || '')))[0];
    const nextNickname =
      normalizeText(canonicalAuth?.nickname, 40) ||
      normalizeText(aliasAuth?.nickname, 40) ||
      normalizeText(store.users[String(canonicalUserId)]?.nickname, 40) ||
      `user_${canonicalUserId}`;
    localAuth[String(canonicalUserId)] = {
      ...sourceAuth,
      user_id: canonicalUserId,
      nickname: nextNickname,
      nickname_key: nicknameKey(nextNickname),
      created_at: canonicalAuth?.created_at || aliasAuth?.created_at || nowIso(),
      updated_at: nowIso(),
    };
    if (aliasUserId !== canonicalUserId) {
      delete localAuth[String(aliasUserId)];
    }
  }

  for (const row of store.comments) {
    const userId = parsePositiveNumber(row?.user_id);
    const publicUserId = parsePositiveNumber(row?.public_user_id);
    if (userId === aliasUserId) row.user_id = canonicalUserId;
    if (publicUserId === aliasUserId) row.public_user_id = canonicalUserId;
  }

  for (const row of store.galleryComments) {
    const userId = parsePositiveNumber(row?.user_id);
    const publicUserId = parsePositiveNumber(row?.public_user_id);
    if (userId === aliasUserId) row.user_id = canonicalUserId;
    if (publicUserId === aliasUserId) row.public_user_id = canonicalUserId;
  }

  for (const row of store.galleryLikes) {
    if (parsePositiveNumber(row?.user_id) === aliasUserId) row.user_id = canonicalUserId;
  }
  store.galleryLikes = dedupeByKey(
    store.galleryLikes,
    (row) => `${parsePositiveNumber(row?.user_id) || 0}:${parsePositiveNumber(row?.gallery_id) || 0}`
  );

  for (const row of store.galleryFavorites) {
    if (parsePositiveNumber(row?.user_id) === aliasUserId) row.user_id = canonicalUserId;
  }
  store.galleryFavorites = dedupeByKey(
    store.galleryFavorites,
    (row) => `${parsePositiveNumber(row?.user_id) || 0}:${parsePositiveNumber(row?.gallery_id) || 0}`
  );

  for (const row of store.items) {
    if (parsePositiveNumber(row?.created_by) === aliasUserId) row.created_by = canonicalUserId;
  }

  if (store.cinemaPollCurrent?.votes_by_user && typeof store.cinemaPollCurrent.votes_by_user === 'object') {
    const nextVotesByUser = {};
    for (const [rawUserId, optionId] of Object.entries(store.cinemaPollCurrent.votes_by_user)) {
      const rawId = parsePositiveNumber(rawUserId);
      if (!rawId) continue;
      const canonicalId = rawId === aliasUserId ? canonicalUserId : resolveCanonicalUserId(rawId) || rawId;
      nextVotesByUser[String(canonicalId)] = String(optionId || '');
    }
    store.cinemaPollCurrent.votes_by_user = nextVotesByUser;
    for (const option of Array.isArray(store.cinemaPollCurrent.options) ? store.cinemaPollCurrent.options : []) {
      option.votes = 0;
    }
    for (const optionId of Object.values(nextVotesByUser)) {
      const option = store.cinemaPollCurrent.options.find((row) => row.id === optionId);
      if (option) option.votes += 1;
    }
  }

  mergeUserMovieStates(canonicalUserId, aliasUserId);
  remapFollowsToCanonicalIds();

  const normalizedSessions = {};
  for (const [rawUserId, session] of Object.entries(store.userSessions || {})) {
    const userId = parsePositiveNumber(rawUserId) || parsePositiveNumber(session?.user_id);
    if (!userId) continue;
    const canonicalId = userId === aliasUserId ? canonicalUserId : resolveCanonicalUserId(userId) || userId;
    const existing = normalizedSessions[String(canonicalId)];
    const nextSession = {
      user_id: canonicalId,
      token: String(session?.token || '').trim(),
      created_at: normalizeIso(session?.created_at, nowIso()),
      updated_at: normalizeIso(session?.updated_at, nowIso()),
    };
    if (!nextSession.token) continue;
    if (!existing || Date.parse(String(nextSession.updated_at || '')) >= Date.parse(String(existing.updated_at || ''))) {
      normalizedSessions[String(canonicalId)] = nextSession;
    }
  }
  store.userSessions = normalizedSessions;

  return canonicalUserId;
}

function findCanonicalUserIdByNickname(nicknameInput) {
  const clean = nicknameKey(nicknameInput);
  if (!clean) return null;
  const profile = Object.values(store.users || {}).find((row) => nicknameKey(row?.nickname) === clean);
  if (!profile) return null;
  return resolveCanonicalUserId(profile.user_id);
}

function resolveCanonicalUserIdForNickname(userIdInput, nicknameInput) {
  const inputUserId = parsePositiveNumber(userIdInput);
  const canonicalFromInput = resolveCanonicalUserId(inputUserId);
  const canonicalFromNickname = findCanonicalUserIdByNickname(nicknameInput);
  if (canonicalFromNickname && canonicalFromInput && canonicalFromNickname !== canonicalFromInput) {
    mergeUserIntoCanonicalUserId(canonicalFromInput, canonicalFromNickname);
    setUserAlias(canonicalFromInput, canonicalFromNickname);
    return canonicalFromNickname;
  }
  if (canonicalFromNickname && inputUserId && canonicalFromNickname !== inputUserId) {
    setUserAlias(inputUserId, canonicalFromNickname);
  }
  return canonicalFromNickname || canonicalFromInput || inputUserId || null;
}

function getAliasUserIdsForCanonical(userIdInput) {
  const canonicalUserId = resolveCanonicalUserId(userIdInput);
  if (!canonicalUserId) return [];
  const aliases = ensureUserAliasesStore();
  const ids = new Set([canonicalUserId]);
  for (const [rawAliasId, rawTargetId] of Object.entries(aliases)) {
    const aliasId = parsePositiveNumber(rawAliasId);
    const targetId = resolveCanonicalUserId(rawTargetId);
    if (!aliasId || !targetId) continue;
    if (targetId === canonicalUserId) ids.add(aliasId);
  }
  return Array.from(ids);
}

function ensureUserProfile(userIdInput, nicknameInput) {
  const userId = resolveCanonicalUserId(userIdInput);
  if (!userId) return null;
  const key = String(userId);
  const existing = store.users[key];
  if (existing && typeof existing === 'object') {
    if (nicknameInput) {
      const nextNickname = normalizeText(nicknameInput, 40);
      if (nextNickname) existing.nickname = nextNickname;
    }
    if (!existing.updated_at) existing.updated_at = nowIso();
    existing.user_id = userId;
    return existing;
  }
  const profile = {
    user_id: userId,
    nickname: normalizeText(nicknameInput, 40) || `user_${userId}`,
    name: null,
    bio: null,
    avatar_url: null,
    privacy: {
      watchlist: false,
      favorites: false,
      watched: false,
      rated: false,
      favorite_actors: false,
      favorite_directors: false,
    },
    watchlist: [],
    favorites: [],
    watched: [],
    rated: [],
    favorite_actors: [],
    favorite_directors: [],
    updated_at: nowIso(),
  };
  store.users[key] = profile;
  return profile;
}

function maintainCanonicalUserMappings() {
  ensureUserAliasesStore();

  const normalizedUsers = {};
  for (const [rawUserId, profile] of Object.entries(store.users || {})) {
    const candidateUserId = parsePositiveNumber(profile?.user_id) || parsePositiveNumber(rawUserId);
    if (!candidateUserId) continue;
    const canonicalUserId = resolveCanonicalUserId(candidateUserId) || candidateUserId;
    const existing = normalizedUsers[String(canonicalUserId)];
    normalizedUsers[String(canonicalUserId)] = mergeUserProfiles(profile, existing, canonicalUserId);
  }
  store.users = normalizedUsers;

  const aliasSnapshot = Object.entries(store.userAliases || {});
  for (const [rawAliasId, rawTargetId] of aliasSnapshot) {
    const aliasId = parsePositiveNumber(rawAliasId);
    const targetId = resolveCanonicalUserId(rawTargetId) || parsePositiveNumber(rawTargetId);
    if (!aliasId || !targetId || aliasId === targetId) continue;
    mergeUserIntoCanonicalUserId(aliasId, targetId);
  }

  const firstByNickname = new Map();
  const profiles = Object.values(store.users || {}).sort(
    (a, b) => (parsePositiveNumber(a?.user_id) || 0) - (parsePositiveNumber(b?.user_id) || 0)
  );
  for (const profile of profiles) {
    const userId = resolveCanonicalUserId(profile?.user_id) || parsePositiveNumber(profile?.user_id);
    const nick = nicknameKey(profile?.nickname);
    if (!userId || !nick) continue;
    const firstId = firstByNickname.get(nick);
    if (firstId && firstId !== userId) {
      mergeUserIntoCanonicalUserId(userId, firstId);
    } else {
      firstByNickname.set(nick, userId);
    }
  }

  const aliases = ensureUserAliasesStore();
  for (const [rawAliasId, rawTargetId] of Object.entries(aliases)) {
    const aliasId = parsePositiveNumber(rawAliasId);
    const targetId = resolveCanonicalUserId(rawTargetId) || parsePositiveNumber(rawTargetId);
    if (!aliasId || !targetId || aliasId === targetId) {
      delete aliases[rawAliasId];
      continue;
    }
    aliases[rawAliasId] = targetId;
  }

  maintainLocalAuthMappings();
  remapFollowsToCanonicalIds();
  ensurePushStores();
  const dedupedPushByToken = new Map();
  for (const row of store.pushTokens) {
    const normalized = normalizePushTokenRecord(row);
    if (!normalized) continue;
    normalized.user_id = resolveCanonicalUserId(normalized.user_id) || normalized.user_id;
    const prev = dedupedPushByToken.get(normalized.expo_push_token);
    if (!prev) {
      dedupedPushByToken.set(normalized.expo_push_token, normalized);
      continue;
    }
    const prevTs = Date.parse(String(prev.updated_at || prev.created_at || ''));
    const nextTs = Date.parse(String(normalized.updated_at || normalized.created_at || ''));
    if (!Number.isFinite(prevTs) || nextTs >= prevTs) {
      dedupedPushByToken.set(normalized.expo_push_token, normalized);
    }
  }
  store.pushTokens = Array.from(dedupedPushByToken.values());
  store.pushState = normalizePushState(store.pushState);
  const maxPushTokenId = store.pushTokens.reduce((acc, row) => {
    return Math.max(acc, parsePositiveNumber(row?.id) || 0);
  }, 0);
  store.pushTokenIdSeq = Math.max(parsePositiveNumber(store.pushTokenIdSeq) || 1, maxPushTokenId + 1);

  const maxProfileUserId = Object.entries(store.users || {}).reduce((acc, [rawUserId, profile]) => {
    const idFromKey = parsePositiveNumber(rawUserId) || 0;
    const idFromProfile = parsePositiveNumber(profile?.user_id) || 0;
    return Math.max(acc, idFromKey, idFromProfile);
  }, 0);
  const maxAuthUserId = Object.entries(store.localAuth || {}).reduce((acc, [rawUserId, row]) => {
    const idFromKey = parsePositiveNumber(rawUserId) || 0;
    const idFromRow = parsePositiveNumber(row?.user_id) || 0;
    return Math.max(acc, idFromKey, idFromRow);
  }, 0);
  store.userIdSeq = Math.max(parsePositiveNumber(store.userIdSeq) || 1, maxProfileUserId + 1, maxAuthUserId + 1);
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

function normalizePersonFavorites(list, maxLen = 200) {
  const entries = Array.isArray(list) ? list : [];
  const unique = new Map();
  for (const row of entries) {
    const personId = parsePositiveNumber(row?.person_id ?? row?.personId ?? row?.id);
    if (!personId) continue;
    const createdAt = normalizeIso(row?.created_at ?? row?.createdAt, nowIso());
    unique.set(personId, {
      person_id: personId,
      created_at: createdAt,
    });
  }
  return Array.from(unique.values())
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
    .slice(0, maxLen);
}

function ensureUserMovieState(userId) {
  const canonicalUserId = resolveCanonicalUserId(userId);
  if (!canonicalUserId) throw new Error('Invalid user id for movie state.');
  const key = String(canonicalUserId);
  const existing = store.movieStates[key];
  if (existing && typeof existing === 'object') {
    const normalized = {
      user_id: Number(existing.user_id) || canonicalUserId,
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
    user_id: canonicalUserId,
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

function togglePersonFavoriteEntry(userIdInput, fieldName, personIdInput) {
  const canonicalUserId = resolveCanonicalUserId(userIdInput);
  if (!canonicalUserId) throw new Error('Invalid user id.');
  if (!['favorite_actors', 'favorite_directors'].includes(String(fieldName))) {
    throw new Error('Invalid favorite list.');
  }
  const personId = parsePositiveNumber(personIdInput);
  if (!personId) throw new Error('person_id is required.');
  const profile = ensureUserProfile(canonicalUserId, null);
  const list = normalizePersonFavorites(profile?.[fieldName], 300);
  const index = list.findIndex((entry) => Number(entry.person_id) === personId);
  if (index >= 0) {
    list.splice(index, 1);
    profile[fieldName] = list;
    profile.updated_at = nowIso();
    return false;
  }
  list.unshift({
    person_id: personId,
    created_at: nowIso(),
  });
  profile[fieldName] = normalizePersonFavorites(list, 300);
  profile.updated_at = nowIso();
  return true;
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
  const seenUsers = new Set();
  for (const [rawUserId, value] of Object.entries(store.movieStates || {})) {
    const userId =
      resolveCanonicalUserId(rawUserId) ||
      resolveCanonicalUserId(value?.user_id) ||
      parsePositiveNumber(rawUserId) ||
      parsePositiveNumber(value?.user_id);
    if (!userId) continue;
    if (seenUsers.has(userId)) continue;
    seenUsers.add(userId);
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

function galleryTitleFromDetails(details) {
  if (!details || typeof details !== 'object') return '';
  return (
    normalizeText(details.TITLE, 120) ||
    normalizeText(details['MOVIE TITLE'], 120) ||
    normalizeText(details.MOVIE, 120) ||
    ''
  );
}

function isAutogeneratedGalleryTitle(value) {
  const clean = normalizeText(value, 200).toLowerCase();
  if (!clean) return false;
  return /^image[\s-_]+\d{8,}(?:[\s-_]+[a-f0-9]{4,})?$/.test(clean);
}

function hasGalleryRichMetadata(item) {
  const detailsCount =
    item?.details && typeof item.details === 'object'
      ? Object.keys(item.details).length
      : 0;
  return !!(
    normalizeText(item?.title_header, 120) ||
    normalizeText(item?.shot_id, 120) ||
    normalizeText(item?.image_id, 120) ||
    detailsCount > 0
  );
}

function normalizeGalleryItemForStore(rawItem) {
  if (!rawItem || typeof rawItem !== 'object') return null;
  const image = normalizeImageUrl(rawItem?.image || rawItem?.image_url || rawItem?.imageUrl);
  if (!image) return null;
  const details = normalizeGalleryDetails(rawItem?.details ?? {});
  const title =
    normalizeText(rawItem?.title, 120) ||
    galleryTitleFromDetails(details) ||
    normalizeText(rawItem?.title_header ?? rawItem?.titleHeader, 120) ||
    normalizeText(rawItem?.image_id ?? rawItem?.imageId, 120) ||
    normalizeText(rawItem?.shot_id ?? rawItem?.shotId, 120) ||
    '';
  if (!title) return null;

  const normalized = {
    title,
    image,
    tag: normalizeGalleryTag(rawItem?.tag),
    height: normalizeGalleryHeight(rawItem?.height),
    shot_id: normalizeText(rawItem?.shot_id ?? rawItem?.shotId, 120) || null,
    title_header: normalizeText(rawItem?.title_header ?? rawItem?.titleHeader, 120) || null,
    image_id: normalizeText(rawItem?.image_id ?? rawItem?.imageId, 120) || null,
    image_url: normalizeImageUrl(rawItem?.image_url ?? rawItem?.imageUrl ?? image) || image,
    palette_hex: normalizeGalleryPalette(rawItem?.palette_hex ?? rawItem?.paletteHex ?? []),
    details,
    created_at: normalizeIso(rawItem?.created_at ?? rawItem?.createdAt, nowIso()),
  };

  if (isAutogeneratedGalleryTitle(normalized.title) && !hasGalleryRichMetadata(normalized)) {
    return null;
  }
  return normalized;
}

function galleryItemIdentityKey(item) {
  const imageUrl = normalizeImageUrl(item?.image_url || item?.image);
  const cloudinaryPublicId = extractCloudinaryPublicId(imageUrl || '');
  if (cloudinaryPublicId) return `cloudinary:${cloudinaryPublicId}`;
  const imageId = normalizeText(item?.image_id, 120).toLowerCase();
  const shotId = normalizeText(item?.shot_id, 120).toLowerCase();
  if (imageId || shotId) return `shot:${imageId}:${shotId}`;
  const title = normalizeText(item?.title, 120).toLowerCase();
  if (imageUrl) return `title-image:${title}:${imageUrl}`;
  return `title:${title}`;
}

function galleryItemQualityScore(item) {
  const detailsCount =
    item?.details && typeof item.details === 'object'
      ? Object.keys(item.details).length
      : 0;
  let score = 0;
  const title = normalizeText(item?.title, 120);
  if (title && !isAutogeneratedGalleryTitle(title)) score += 6;
  else if (title) score += 1;
  if (normalizeText(item?.title_header, 120)) score += 2;
  if (normalizeText(item?.shot_id, 120)) score += 2;
  if (normalizeText(item?.image_id, 120)) score += 2;
  if (detailsCount > 0) score += Math.min(detailsCount, 8);
  if (normalizeImageUrl(item?.image_url || item?.image)) score += 2;
  if (normalizeGalleryPalette(item?.palette_hex).length > 0) score += 1;
  return score;
}

function normalizeAndDedupeGalleryItems(rows, options = {}) {
  const preserveIds = options?.preserveIds !== false;
  const byIdentity = new Map();

  for (const row of Array.isArray(rows) ? rows : []) {
    const normalized = normalizeGalleryItemForStore(row);
    if (!normalized) continue;

    const requestedId = preserveIds ? parsePositiveNumber(row?.id) || null : null;
    const identityKey = galleryItemIdentityKey(normalized);
    const current = byIdentity.get(identityKey);

    const candidate = {
      ...normalized,
      id: requestedId,
    };

    if (!current) {
      byIdentity.set(identityKey, candidate);
      continue;
    }

    const currentScore = galleryItemQualityScore(current);
    const candidateScore = galleryItemQualityScore(candidate);
    if (candidateScore > currentScore) {
      byIdentity.set(identityKey, {
        ...candidate,
        // Preserve existing id to avoid breaking likes/comments links.
        id: current.id || candidate.id || null,
      });
    }
  }

  const deduped = Array.from(byIdentity.values()).sort(
    (a, b) => Date.parse(String(b?.created_at || '')) - Date.parse(String(a?.created_at || ''))
  );

  const usedIds = new Set();
  let nextId = deduped.reduce((acc, row) => Math.max(acc, parsePositiveNumber(row?.id) || 0), 0) + 1;

  for (const row of deduped) {
    let id = parsePositiveNumber(row?.id);
    if (!id || usedIds.has(id)) {
      id = nextId++;
    }
    usedIds.add(id);
    row.id = id;
  }

  return deduped;
}

function getGalleryItemById(galleryId) {
  return store.galleryItems.find((item) => Number(item.id) === Number(galleryId)) || null;
}

function normalizeGalleryStoreInPlace() {
  const beforeItemsSignature = JSON.stringify(
    (Array.isArray(store.galleryItems) ? store.galleryItems : []).map((row) => ({
      id: parsePositiveNumber(row?.id) || 0,
      title: normalizeText(row?.title, 120),
      image: normalizeImageUrl(row?.image_url || row?.image) || '',
      detailsCount: row?.details && typeof row.details === 'object' ? Object.keys(row.details).length : 0,
    }))
  );
  const beforeLikesLen = Array.isArray(store.galleryLikes) ? store.galleryLikes.length : 0;
  const beforeFavoritesLen = Array.isArray(store.galleryFavorites) ? store.galleryFavorites.length : 0;
  const beforeCommentsLen = Array.isArray(store.galleryComments) ? store.galleryComments.length : 0;

  store.galleryItems = normalizeAndDedupeGalleryItems(store.galleryItems);
  const validIds = new Set(
    store.galleryItems
      .map((row) => parsePositiveNumber(row?.id))
      .filter((id) => !!id)
  );
  store.galleryLikes = dedupeByKey(
    store.galleryLikes.filter((row) => validIds.has(parsePositiveNumber(row?.gallery_id))),
    (row) => `${parsePositiveNumber(row?.user_id) || 0}:${parsePositiveNumber(row?.gallery_id) || 0}`
  );
  store.galleryFavorites = dedupeByKey(
    store.galleryFavorites.filter((row) => validIds.has(parsePositiveNumber(row?.gallery_id))),
    (row) => `${parsePositiveNumber(row?.user_id) || 0}:${parsePositiveNumber(row?.gallery_id) || 0}`
  );
  store.galleryComments = store.galleryComments.filter((row) =>
    validIds.has(parsePositiveNumber(row?.gallery_id))
  );
  store.galleryIdSeq =
    store.galleryItems.reduce((acc, row) => Math.max(acc, parsePositiveNumber(row?.id) || 0), 0) + 1;
  store.galleryCommentIdSeq =
    store.galleryComments.reduce((acc, row) => Math.max(acc, parsePositiveNumber(row?.id) || 0), 0) + 1;

  const afterItemsSignature = JSON.stringify(
    store.galleryItems.map((row) => ({
      id: parsePositiveNumber(row?.id) || 0,
      title: normalizeText(row?.title, 120),
      image: normalizeImageUrl(row?.image_url || row?.image) || '',
      detailsCount: row?.details && typeof row.details === 'object' ? Object.keys(row.details).length : 0,
    }))
  );

  return (
    beforeItemsSignature !== afterItemsSignature ||
    beforeLikesLen !== store.galleryLikes.length ||
    beforeFavoritesLen !== store.galleryFavorites.length ||
    beforeCommentsLen !== store.galleryComments.length
  );
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
  const canonicalUserId = resolveCanonicalUserId(userId);
  const profile = canonicalUserId ? store.users[String(canonicalUserId)] : null;
  if (!profile) return fallback;
  const nickname = normalizeText(profile.nickname, 40);
  return nickname || fallback;
}

function resolveAvatarForUser(userId, fallback = null) {
  const canonicalUserId = resolveCanonicalUserId(userId);
  const profile = canonicalUserId ? store.users[String(canonicalUserId)] : null;
  const avatarFromProfile = normalizeAvatarUrl(profile?.avatar_url);
  if (avatarFromProfile) return avatarFromProfile;
  return normalizeAvatarUrl(fallback);
}

function resolveCommentIdentity(row) {
  const fallbackUserId = resolveCanonicalUserId(row?.user_id) || parsePositiveNumber(row?.user_id) || null;
  const publicUserId =
    resolveCanonicalUserId(row?.public_user_id) ||
    parsePositiveNumber(row?.public_user_id) ||
    resolvePublicUserIdForNickname(row?.nickname, fallbackUserId) ||
    fallbackUserId;
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

function collectReplyNotificationsForUser(userIdInput, options = {}) {
  const userId = resolveCanonicalUserId(userIdInput) || parsePositiveNumber(userIdInput);
  if (!userId) return [];
  const sinceRaw = String(options.since || '').trim();
  const sinceTs = Number.isFinite(Date.parse(sinceRaw)) ? Date.parse(sinceRaw) : null;
  const limitRaw = parsePositiveNumber(options.limit);
  const limit = Math.max(1, Math.min(300, limitRaw || 80));
  const result = [];

  const pushReply = (row, parentRow, source) => {
    const parentIdentity = resolveCommentIdentity(parentRow);
    const parentUserId = parsePositiveNumber(parentIdentity.public_user_id || parentRow?.user_id);
    if (!parentUserId || parentUserId !== userId) return;
    const replyIdentity = resolveCommentIdentity(row);
    const fromUserId = parsePositiveNumber(replyIdentity.public_user_id || row?.user_id);
    if (!fromUserId || fromUserId === userId) return;
    const createdAt = normalizeIso(row?.created_at, nowIso());
    if (sinceTs && Date.parse(createdAt) <= sinceTs) return;
    result.push({
      source,
      reply_id: parsePositiveNumber(row?.id) || 0,
      parent_id: parsePositiveNumber(parentRow?.id) || 0,
      created_at: createdAt,
      text: normalizeText(row?.text, 1000),
      from_user_id: fromUserId,
      from_nickname: normalizeText(replyIdentity.nickname, 80) || `user_${fromUserId}`,
      from_avatar_url: normalizeAvatarUrl(replyIdentity.avatar_url),
      tmdb_id: source === 'movie' ? parsePositiveNumber(row?.tmdb_id) : null,
      gallery_id: source === 'gallery' ? parsePositiveNumber(row?.gallery_id) : null,
    });
  };

  const movieById = new Map();
  for (const row of store.comments || []) {
    const id = parsePositiveNumber(row?.id);
    if (!id) continue;
    movieById.set(id, row);
  }
  for (const row of store.comments || []) {
    const parentId = parsePositiveNumber(row?.parent_id);
    if (!parentId) continue;
    const parentRow = movieById.get(parentId);
    if (!parentRow) continue;
    pushReply(row, parentRow, 'movie');
  }

  const galleryById = new Map();
  for (const row of store.galleryComments || []) {
    const id = parsePositiveNumber(row?.id);
    if (!id) continue;
    galleryById.set(id, row);
  }
  for (const row of store.galleryComments || []) {
    const parentId = parsePositiveNumber(row?.parent_id);
    if (!parentId) continue;
    const parentRow = galleryById.get(parentId);
    if (!parentRow) continue;
    pushReply(row, parentRow, 'gallery');
  }

  return result
    .filter((row) => row.reply_id > 0 && row.parent_id > 0 && !!row.text)
    .sort((a, b) => Date.parse(String(b.created_at || '')) - Date.parse(String(a.created_at || '')))
    .slice(0, limit);
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
  const canonicalUserId = resolveCanonicalUserId(publicUserId || userId) || userId;
  const nickname = resolveNicknameForUser(publicUserId, rawNickname);
  const avatarUrl = resolveAvatarForUser(publicUserId, input?.avatar_url);
  return {
    user_id: canonicalUserId,
    public_user_id: resolveCanonicalUserId(publicUserId || canonicalUserId) || canonicalUserId,
    gallery_id: galleryId,
    nickname,
    avatar_url: avatarUrl,
    text,
    parent_id: parentId || null,
  };
}

function toggleGalleryReaction(list, userId, galleryId) {
  const canonicalUserId = resolveCanonicalUserId(userId) || parsePositiveNumber(userId);
  if (!canonicalUserId) return false;
  const idx = list.findIndex(
    (row) => Number(row.user_id) === Number(canonicalUserId) && Number(row.gallery_id) === Number(galleryId)
  );
  if (idx >= 0) {
    list.splice(idx, 1);
    return false;
  }
  list.push({
    user_id: Number(canonicalUserId),
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
  const userId = resolveCanonicalUserId(userIdInput);
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
  const userId = resolveCanonicalUserId(userIdInput) || parsePositiveNumber(userIdInput);
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
  const userId = resolveCanonicalUserId(userIdInput) || parsePositiveNumber(userIdInput);
  if (!userId) return { ok: false, status: 400, error: 'user_id is required.' };
  const session = getUserSession(userId);
  if (!session) return { ok: false, status: 401, error: 'Session missing. Sync profile first.' };
  const token = getUserTokenFromRequest(req);
  if (!token) return { ok: false, status: 401, error: 'Missing x-user-token header.' };
  if (token !== session.token) return { ok: false, status: 403, error: 'Invalid user session token.' };
  return { ok: true, userId };
}

function recalculateCurrentCinemaPollVotes() {
  const poll = store.cinemaPollCurrent;
  if (!poll || !Array.isArray(poll.options)) return;
  for (const option of poll.options) {
    option.votes = 0;
  }
  const votesByUser = poll.votes_by_user && typeof poll.votes_by_user === 'object' ? poll.votes_by_user : {};
  for (const optionId of Object.values(votesByUser)) {
    const option = poll.options.find((row) => row.id === optionId);
    if (option) option.votes += 1;
  }
  poll.updated_at = nowIso();
}

function deleteUserAccountFromStore(userIdInput) {
  const canonicalUserId = resolveCanonicalUserId(userIdInput) || parsePositiveNumber(userIdInput);
  if (!canonicalUserId) throw new Error('Invalid user id.');

  const aliasIds = Array.from(
    new Set([canonicalUserId, ...getAliasUserIdsForCanonical(canonicalUserId)].map((id) => parsePositiveNumber(id)).filter(Boolean))
  );
  const deletedIdsSet = new Set(aliasIds);
  const avatarUrls = [];

  for (const id of aliasIds) {
    const profile = store.users[String(id)];
    const avatarUrl = normalizeAvatarUrl(profile?.avatar_url);
    if (avatarUrl && isCloudinaryImageOwnedByUser(avatarUrl, canonicalUserId)) {
      avatarUrls.push(avatarUrl);
    }
  }

  for (const id of aliasIds) {
    delete store.users[String(id)];
    delete store.movieStates[String(id)];
    delete ensureLocalAuthStore()[String(id)];
    delete store.userSessions[String(id)];
  }

  store.comments = store.comments.filter((row) => {
    const userId = parsePositiveNumber(row?.user_id);
    const publicUserId = parsePositiveNumber(row?.public_user_id);
    return !deletedIdsSet.has(userId) && !deletedIdsSet.has(publicUserId);
  });

  store.galleryComments = store.galleryComments.filter((row) => {
    const userId = parsePositiveNumber(row?.user_id);
    const publicUserId = parsePositiveNumber(row?.public_user_id);
    return !deletedIdsSet.has(userId) && !deletedIdsSet.has(publicUserId);
  });

  store.galleryLikes = store.galleryLikes.filter((row) => !deletedIdsSet.has(parsePositiveNumber(row?.user_id)));
  store.galleryFavorites = store.galleryFavorites.filter((row) => !deletedIdsSet.has(parsePositiveNumber(row?.user_id)));
  removePushTokensForUsers(aliasIds);

  if (store.cinemaPollCurrent?.votes_by_user && typeof store.cinemaPollCurrent.votes_by_user === 'object') {
    const nextVotesByUser = {};
    for (const [rawUserId, optionId] of Object.entries(store.cinemaPollCurrent.votes_by_user)) {
      const userId = parsePositiveNumber(rawUserId);
      if (!userId || deletedIdsSet.has(userId)) continue;
      nextVotesByUser[String(userId)] = String(optionId || '');
    }
    store.cinemaPollCurrent.votes_by_user = nextVotesByUser;
    recalculateCurrentCinemaPollVotes();
  }

  for (const event of store.items) {
    const createdBy = parsePositiveNumber(event?.created_by);
    if (deletedIdsSet.has(createdBy)) {
      event.created_by = null;
      event.updated_at = nowIso();
    }
  }

  const nextFollows = {};
  for (const [rawFollowerId, rawTargets] of Object.entries(store.follows || {})) {
    const followerId = parsePositiveNumber(rawFollowerId);
    if (!followerId || deletedIdsSet.has(followerId)) continue;
    const targetSet = new Set();
    for (const rawTargetId of Array.isArray(rawTargets) ? rawTargets : []) {
      const targetId = parsePositiveNumber(rawTargetId);
      if (!targetId || deletedIdsSet.has(targetId) || targetId === followerId) continue;
      targetSet.add(targetId);
    }
    nextFollows[String(followerId)] = Array.from(targetSet);
  }
  store.follows = nextFollows;

  const aliases = ensureUserAliasesStore();
  for (const [rawAliasId, rawTargetId] of Object.entries({ ...aliases })) {
    const aliasId = parsePositiveNumber(rawAliasId);
    const targetId = parsePositiveNumber(rawTargetId);
    if (!aliasId || !targetId || deletedIdsSet.has(aliasId) || deletedIdsSet.has(targetId)) {
      delete aliases[rawAliasId];
    }
  }

  maintainCanonicalUserMappings();

  return {
    deleted_user_id: canonicalUserId,
    deleted_alias_ids: aliasIds,
    avatar_urls: Array.from(new Set(avatarUrls)),
  };
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
  const canonicalUserId = resolveCanonicalUserId(userIdInput) || parsePositiveNumber(userIdInput);
  if (!canonicalUserId) return false;
  const publicId = extractCloudinaryPublicId(imageUrl);
  if (!publicId) return false;
  const userIds = getAliasUserIdsForCanonical(canonicalUserId);
  return userIds.some((userId) => new RegExp(`(^|/)u-${userId}(/|$)`).test(publicId));
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

function collectCloudinaryImageUrlsFromGalleryItem(item) {
  const urls = new Set();
  const directImage = String(item?.image || '').trim();
  const imageUrl = String(item?.image_url || '').trim();
  if (directImage && extractCloudinaryPublicId(directImage)) urls.add(directImage);
  if (imageUrl && extractCloudinaryPublicId(imageUrl)) urls.add(imageUrl);
  return urls;
}

function canUseCloudinaryServerCredentials() {
  return !!(cloudinaryCloudName && cloudinaryApiKey && cloudinaryApiSecret);
}

function cloudinaryBasicAuthHeader() {
  return `Basic ${Buffer.from(`${cloudinaryApiKey}:${cloudinaryApiSecret}`).toString('base64')}`;
}

async function cloudinaryGetJson(endpoint) {
  if (!canUseCloudinaryServerCredentials()) return null;
  const res = await fetch(endpoint, {
    method: 'GET',
    headers: {
      authorization: cloudinaryBasicAuthHeader(),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = data?.error?.message || `Cloudinary API error ${res.status}`;
    throw new Error(message);
  }
  return data;
}

function normalizeCloudinaryResourceTypeForApi(input) {
  const clean = String(input || '').trim().toLowerCase();
  if (clean === 'raw') return 'raw';
  if (clean === 'video') return 'video';
  return 'image';
}

async function listCloudinaryResources(resourceType, params = {}) {
  if (!canUseCloudinaryServerCredentials()) return [];
  const cleanResourceType = normalizeCloudinaryResourceTypeForApi(resourceType);
  const resources = [];
  let nextCursor = null;
  do {
    const search = new URLSearchParams({
      max_results: '500',
      ...params,
      context: 'true',
      tags: 'true',
    });
    if (nextCursor) search.set('next_cursor', nextCursor);
    const endpoint = `https://api.cloudinary.com/v1_1/${cloudinaryCloudName}/resources/${cleanResourceType}/upload?${search.toString()}`;
    const payload = await cloudinaryGetJson(endpoint);
    const rows = Array.isArray(payload?.resources) ? payload.resources : [];
    for (const row of rows) resources.push(row);
    nextCursor = typeof payload?.next_cursor === 'string' ? payload.next_cursor : null;
  } while (nextCursor && resources.length < 5000);
  return resources;
}

async function listCloudinaryResourcesByTag(resourceType, tag) {
  if (!canUseCloudinaryServerCredentials()) return [];
  const cleanResourceType = normalizeCloudinaryResourceTypeForApi(resourceType);
  const cleanTag = String(tag || '').trim();
  if (!cleanTag) return [];
  const resources = [];
  let nextCursor = null;
  do {
    const search = new URLSearchParams({
      max_results: '500',
      context: 'true',
      tags: 'true',
    });
    if (nextCursor) search.set('next_cursor', nextCursor);
    const endpoint = `https://api.cloudinary.com/v1_1/${cloudinaryCloudName}/resources/${cleanResourceType}/tags/${encodeURIComponent(cleanTag)}?${search.toString()}`;
    const payload = await cloudinaryGetJson(endpoint);
    const rows = Array.isArray(payload?.resources) ? payload.resources : [];
    for (const row of rows) resources.push(row);
    nextCursor = typeof payload?.next_cursor === 'string' ? payload.next_cursor : null;
  } while (nextCursor && resources.length < 5000);
  return resources;
}

async function listCloudinaryImageResources(params = {}) {
  return listCloudinaryResources('image', params);
}

async function listCloudinaryImageResourcesByTag(tag) {
  return listCloudinaryResourcesByTag('image', tag);
}

function parseCloudinaryHexPalette(input) {
  return String(input || '')
    .split(',')
    .map((x) => String(x).trim())
    .filter((x) => /^#[0-9a-fA-F]{6}$/.test(x));
}

function sanitizeCloudinaryContextKey(input) {
  return String(input || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
}

function sanitizeCloudinaryContextValue(input, maxLen = 1000) {
  return String(input || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/([\\|=])/g, '\\$1')
    .trim()
    .slice(0, maxLen);
}

function serializeCloudinaryContextObject(input) {
  const pairs = Object.entries(input || {})
    .map(([rawKey, rawValue]) => {
      const key = sanitizeCloudinaryContextKey(rawKey);
      const value = sanitizeCloudinaryContextValue(rawValue);
      if (!key || !value) return null;
      return `${key}=${value}`;
    })
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
  return pairs.join('|');
}

function parseGalleryDetailsFromCloudinaryContext(input) {
  const raw = String(input || '').trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return normalizeGalleryDetails(parsed);
  } catch {
    return {};
  }
}

function serializeGalleryDetailsForCloudinaryContext(input) {
  const normalized = normalizeGalleryDetails(input);
  if (!Object.keys(normalized).length) return '';

  const candidate = {};
  for (const [key, value] of Object.entries(normalized).slice(0, 24)) {
    const safeKey = normalizeText(key, 60);
    const safeValue = normalizeText(value, 180);
    if (!safeKey || !safeValue) continue;
    candidate[safeKey] = safeValue;
  }
  let serialized = JSON.stringify(candidate);
  if (serialized.length <= 900) return serialized;

  const compact = {};
  for (const [key, value] of Object.entries(candidate)) {
    compact[key] = normalizeText(value, 80);
  }
  serialized = JSON.stringify(compact);
  if (serialized.length <= 900) return serialized;

  const minimal = {};
  for (const key of ['TITLE', 'MOVIE TITLE', 'MOVIE', 'GENRE', 'YEAR', 'DIRECTOR', 'ACTORS', 'TAGS']) {
    if (compact[key]) minimal[key] = compact[key];
  }
  serialized = JSON.stringify(minimal);
  return serialized.length <= 900 ? serialized : '';
}

function cloudinaryResourceToGalleryItem(resource, usedIds) {
  const secureUrl = normalizeImageUrl(resource?.secure_url || resource?.url);
  const publicId = normalizeText(resource?.public_id, 240);
  if (!secureUrl || !publicId) return null;

  const ctxRaw = resource?.context?.custom;
  const ctx = ctxRaw && typeof ctxRaw === 'object' ? ctxRaw : {};
  const hasGalleryContext =
    !!normalizeText(ctx.g_title, 120) ||
    !!normalizeText(ctx.g_tag, 60) ||
    !!normalizeText(ctx.g_shot_id, 120) ||
    !!normalizeText(ctx.g_image_id, 120) ||
    !!normalizeText(ctx.g_title_header, 120) ||
    !!String(ctx.g_palette_hex || '').trim() ||
    !!String(ctx.g_details || '').trim();
  if (!hasGalleryContext) {
    // Skip orphan Cloudinary images that were uploaded without gallery metadata.
    return null;
  }
  const candidate = normalizeGalleryItemForStore({
    title: normalizeText(ctx.g_title, 120) || '',
    image: secureUrl,
    tag: normalizeGalleryTag(ctx.g_tag),
    height: normalizeGalleryHeight(ctx.g_height),
    shot_id: normalizeText(ctx.g_shot_id, 120) || null,
    title_header: normalizeText(ctx.g_title_header, 120) || null,
    image_id: normalizeText(ctx.g_image_id, 120) || null,
    image_url: secureUrl,
    palette_hex: parseCloudinaryHexPalette(ctx.g_palette_hex),
    details: parseGalleryDetailsFromCloudinaryContext(ctx.g_details),
    created_at: normalizeIso(resource?.created_at, nowIso()),
  });
  if (!candidate) {
    return null;
  }

  let id = Number.parseInt(crypto.createHash('md5').update(publicId).digest('hex').slice(0, 8), 16);
  if (!Number.isFinite(id) || id <= 0) id = usedIds.size + 1;
  while (usedIds.has(id)) id += 1;
  usedIds.add(id);

  return {
    id,
    ...candidate,
  };
}

async function listCloudinaryGalleryResources() {
  if (!canUseCloudinaryServerCredentials()) return [];
  const byTag = await listCloudinaryImageResourcesByTag(CLOUDINARY_GALLERY_TAG);
  const byFolder = await listCloudinaryImageResources({ prefix: `${CLOUDINARY_GALLERY_FOLDER}/` });
  const seen = new Set();
  const merged = [];
  for (const row of [...byTag, ...byFolder]) {
    const key = String(row?.public_id || '').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(row);
  }
  return merged;
}

async function tagCloudinaryAssetAsGallery(item) {
  if (!canUseCloudinaryServerCredentials()) return false;
  const publicId = extractCloudinaryPublicId(item?.image_url || item?.image);
  if (!publicId) return false;
  if (taggedGalleryCloudinaryPublicIds.has(publicId)) return true;
  const detailsContext = serializeGalleryDetailsForCloudinaryContext(item?.details || {});

  const context = serializeCloudinaryContextObject({
    g_title: item?.title,
    g_tag: item?.tag,
    g_height: String(item?.height || ''),
    g_shot_id: item?.shot_id || '',
    g_title_header: item?.title_header || '',
    g_image_id: item?.image_id || '',
    g_palette_hex: Array.isArray(item?.palette_hex) ? item.palette_hex.join(',') : '',
    g_details: detailsContext,
  });

  const timestamp = Math.floor(Date.now() / 1000);
  const toSign = {
    public_id: publicId,
    timestamp,
    type: 'upload',
    tags: CLOUDINARY_GALLERY_TAG,
    context,
  };
  const signature = signCloudinaryParams(toSign);
  const endpoint = `https://api.cloudinary.com/v1_1/${cloudinaryCloudName}/image/explicit`;

  const form = new URLSearchParams();
  form.set('public_id', publicId);
  form.set('timestamp', String(timestamp));
  form.set('api_key', cloudinaryApiKey);
  form.set('signature', signature);
  form.set('type', 'upload');
  form.set('tags', CLOUDINARY_GALLERY_TAG);
  if (context) {
    form.set('context', context);
  }

  const res = await fetch(endpoint, { method: 'POST', body: form });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = data?.error?.message || `Cloudinary explicit failed with status ${res.status}`;
    throw new Error(message);
  }
  taggedGalleryCloudinaryPublicIds.add(publicId);
  return true;
}

let galleryHydratePromise = null;
let galleryHydrateLastAttemptAt = 0;
const GALLERY_HYDRATE_RETRY_MS = 30_000;
const taggedGalleryCloudinaryPublicIds = new Set();
let galleryTagSyncPromise = null;

async function ensureStoredGalleryItemsTaggedInCloudinary() {
  if (!canUseCloudinaryServerCredentials()) return;
  if (!store.galleryItems.length) return;
  if (galleryTagSyncPromise) return galleryTagSyncPromise;
  galleryTagSyncPromise = (async () => {
    for (const item of store.galleryItems) {
      try {
        await tagCloudinaryAssetAsGallery(item);
      } catch (err) {
        console.warn(
          'Cloudinary gallery tag sync skipped:',
          err instanceof Error ? err.message : String(err)
        );
      }
    }
  })().finally(() => {
    galleryTagSyncPromise = null;
  });
  return galleryTagSyncPromise;
}

async function ensureGalleryHydratedFromCloudinary(force = false) {
  if (!canUseCloudinaryServerCredentials()) return;
  if (!force && store.galleryItems.length) return;
  const now = Date.now();
  if (!force && now - galleryHydrateLastAttemptAt < GALLERY_HYDRATE_RETRY_MS) return;
  if (galleryHydratePromise) return galleryHydratePromise;

  galleryHydrateLastAttemptAt = now;
  galleryHydratePromise = (async () => {
    const resources = await listCloudinaryGalleryResources();
    if (!resources.length) return;
    const usedIds = new Set();
    const hydratedItemsRaw = resources
      .sort((a, b) => Date.parse(String(b?.created_at || '')) - Date.parse(String(a?.created_at || '')))
      .map((resource) => cloudinaryResourceToGalleryItem(resource, usedIds))
      .filter(Boolean);
    const hydratedItems = normalizeAndDedupeGalleryItems(hydratedItemsRaw);
    if (!hydratedItems.length) return;

    store.galleryItems = hydratedItems;
    store.galleryIdSeq = hydratedItems.reduce((acc, row) => Math.max(acc, Number(row.id) || 0), 0) + 1;
    const validIds = new Set(hydratedItems.map((row) => Number(row.id)));
    store.galleryLikes = store.galleryLikes.filter((row) => validIds.has(Number(row.gallery_id)));
    store.galleryFavorites = store.galleryFavorites.filter((row) => validIds.has(Number(row.gallery_id)));
    store.galleryComments = store.galleryComments.filter((row) => validIds.has(Number(row.gallery_id)));
    store.galleryCommentIdSeq =
      store.galleryComments.reduce((acc, row) => Math.max(acc, parsePositiveNumber(row?.id) || 0), 0) + 1;
    saveStore(store);
  })()
    .catch((err) => {
      console.error('Cloudinary gallery hydrate failed:', err instanceof Error ? err.message : String(err));
    })
    .finally(() => {
      galleryHydratePromise = null;
    });
  return galleryHydratePromise;
}

function pickLatestCloudinaryResource(resources) {
  const list = Array.isArray(resources) ? resources : [];
  if (!list.length) return null;
  return [...list].sort((a, b) => Date.parse(String(b?.created_at || '')) - Date.parse(String(a?.created_at || '')))[0] || null;
}

async function listCloudinaryStoreResources() {
  if (!canUseCloudinaryServerCredentials()) return [];
  const byPrefix = await listCloudinaryResources('raw', { prefix: `${CLOUDINARY_STORE_PUBLIC_ID}` });
  const byTag = await listCloudinaryResourcesByTag('raw', CLOUDINARY_STORE_TAG);
  const seen = new Set();
  const merged = [];
  for (const row of [...byPrefix, ...byTag]) {
    const publicId = normalizeText(row?.public_id, 280);
    if (!publicId || seen.has(publicId)) continue;
    seen.add(publicId);
    merged.push(row);
  }
  return merged;
}

async function fetchCloudinaryStoreState() {
  if (!canUseCloudinaryServerCredentials()) return null;
  const resources = await listCloudinaryStoreResources();
  if (!resources.length) return null;
  const exact = resources.filter((row) => normalizeText(row?.public_id, 280) === CLOUDINARY_STORE_PUBLIC_ID);
  const resource = pickLatestCloudinaryResource(exact.length ? exact : resources);
  if (!resource) return null;
  const fileUrl = normalizeImageUrl(resource?.secure_url || resource?.url);
  if (!fileUrl) return null;
  const res = await fetch(fileUrl, { method: 'GET' });
  if (!res.ok) throw new Error(`Cloudinary store download failed with status ${res.status}`);
  const raw = await res.text();
  const clean = String(raw || '').trim();
  if (!clean) return null;
  const parsed = JSON.parse(clean);
  return hydrateStoreState(parsed);
}

async function uploadStoreSnapshotToCloudinary(serializedStore) {
  if (!canUseCloudinaryServerCredentials()) return false;
  const cleanSerialized = String(serializedStore || '').trim();
  if (!cleanSerialized) return false;

  const timestamp = Math.floor(Date.now() / 1000);
  const signature = signCloudinaryParams({
    public_id: CLOUDINARY_STORE_PUBLIC_ID,
    timestamp,
    overwrite: 'true',
    invalidate: 'true',
    tags: CLOUDINARY_STORE_TAG,
  });
  const endpoint = `https://api.cloudinary.com/v1_1/${cloudinaryCloudName}/raw/upload`;
  const form = new FormData();
  form.set('public_id', CLOUDINARY_STORE_PUBLIC_ID);
  form.set('timestamp', String(timestamp));
  form.set('overwrite', 'true');
  form.set('invalidate', 'true');
  form.set('tags', CLOUDINARY_STORE_TAG);
  form.set('api_key', cloudinaryApiKey);
  form.set('signature', signature);
  form.set(
    'file',
    new Blob([cleanSerialized], { type: 'application/json; charset=utf-8' }),
    CLOUDINARY_STORE_FILENAME
  );

  const res = await fetch(endpoint, { method: 'POST', body: form });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = data?.error?.message || `Cloudinary store upload failed with status ${res.status}`;
    throw new Error(message);
  }
  return true;
}

let cloudStoreSyncTimer = null;
let cloudStoreSyncInProgress = false;
let cloudStorePendingSerialized = null;
let cloudStoreRestoreAttempted = false;
let cloudStoreRestorePromise = null;

async function flushCloudStoreSyncQueue() {
  if (!canUseCloudinaryServerCredentials()) return;
  if (cloudStoreSyncInProgress) return;
  const pending = cloudStorePendingSerialized;
  if (!pending) return;
  cloudStorePendingSerialized = null;
  cloudStoreSyncInProgress = true;
  try {
    await uploadStoreSnapshotToCloudinary(pending);
  } catch (err) {
    console.error('Cloudinary store sync failed:', err instanceof Error ? err.message : String(err));
    cloudStorePendingSerialized = pending;
  } finally {
    cloudStoreSyncInProgress = false;
  }
  if (cloudStorePendingSerialized) {
    if (cloudStoreSyncTimer) clearTimeout(cloudStoreSyncTimer);
    cloudStoreSyncTimer = setTimeout(() => {
      cloudStoreSyncTimer = null;
      void flushCloudStoreSyncQueue();
    }, CLOUDINARY_STORE_SYNC_DEBOUNCE_MS);
  }
}

function scheduleCloudStoreSync(serializedStore) {
  if (!canUseCloudinaryServerCredentials()) return;
  const cleanSerialized = String(serializedStore || '').trim();
  if (!cleanSerialized) return;
  cloudStorePendingSerialized = cleanSerialized;
  if (cloudStoreSyncTimer) clearTimeout(cloudStoreSyncTimer);
  cloudStoreSyncTimer = setTimeout(() => {
    cloudStoreSyncTimer = null;
    void flushCloudStoreSyncQueue();
  }, CLOUDINARY_STORE_SYNC_DEBOUNCE_MS);
}

async function forceCloudStoreSyncFromStore() {
  if (!canUseCloudinaryServerCredentials()) return false;
  store.store_updated_at = nowIso();
  const serialized = JSON.stringify(store, null, 2);
  saveStoreLocallyOnly(store);
  await uploadStoreSnapshotToCloudinary(serialized);
  return true;
}

async function restoreStoreFromCloudinaryBackup(force = false) {
  if (!canUseCloudinaryServerCredentials()) return false;
  if (!force && cloudStoreRestoreAttempted) return false;
  if (cloudStoreRestorePromise && !force) return cloudStoreRestorePromise;
  cloudStoreRestoreAttempted = true;
  cloudStoreRestorePromise = (async () => {
    const remoteStore = await fetchCloudinaryStoreState();
    if (!remoteStore) return false;
    store = remoteStore;
    saveStoreLocallyOnly(store);
    return true;
  })()
    .catch((err) => {
      console.error('Cloudinary store restore failed:', err instanceof Error ? err.message : String(err));
      return false;
    })
    .finally(() => {
      cloudStoreRestorePromise = null;
    });
  return cloudStoreRestorePromise;
}

let shutdownSyncInProgress = false;

async function flushCloudStoreSyncOnShutdown(signalName) {
  if (shutdownSyncInProgress) return;
  shutdownSyncInProgress = true;
  try {
    if (cloudStoreSyncTimer) {
      clearTimeout(cloudStoreSyncTimer);
      cloudStoreSyncTimer = null;
    }
    await flushCloudStoreSyncQueue();
  } catch (err) {
    console.error(
      `Cloudinary store final sync failed on ${signalName}:`,
      err instanceof Error ? err.message : String(err)
    );
  } finally {
    process.exit(0);
  }
}

function registerShutdownSyncHandlers() {
  process.on('SIGTERM', () => {
    void flushCloudStoreSyncOnShutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    void flushCloudStoreSyncOnShutdown('SIGINT');
  });
}

async function cleanupGalleryItemCloudinaryMedia(item) {
  const imageUrls = collectCloudinaryImageUrlsFromGalleryItem(item);
  for (const imageUrl of imageUrls) {
    await destroyCloudinaryImageByUrl(imageUrl);
  }
  return { deleted_images: imageUrls.size };
}

async function cleanupAllStoreCloudinaryMedia(options = {}) {
  const preserveCanonicalUserIds = new Set(
    (Array.isArray(options.preserveUserIds) ? options.preserveUserIds : [])
      .map((value) => resolveCanonicalUserId(value) || parsePositiveNumber(value))
      .filter(Boolean)
  );
  const imageUrls = new Set();
  const videoUrls = new Set();
  const rawUrls = new Set();

  for (const item of store.items) {
    const videoUrl = String(item?.video_url || '').trim();
    const posterUrl = String(item?.poster_url || '').trim();
    if (videoUrl && extractCloudinaryPublicId(videoUrl)) videoUrls.add(videoUrl);
    if (posterUrl && extractCloudinaryPublicId(posterUrl)) imageUrls.add(posterUrl);
  }

  for (const item of store.galleryItems) {
    const galleryUrls = collectCloudinaryImageUrlsFromGalleryItem(item);
    for (const imageUrl of galleryUrls) imageUrls.add(imageUrl);
  }

  for (const profile of Object.values(store.users || {})) {
    const profileUserId = parsePositiveNumber(profile?.user_id);
    const canonicalProfileUserId = resolveCanonicalUserId(profileUserId) || profileUserId;
    if (canonicalProfileUserId && preserveCanonicalUserIds.has(canonicalProfileUserId)) continue;
    const avatarUrl = String(profile?.avatar_url || '').trim();
    if (avatarUrl && extractCloudinaryPublicId(avatarUrl)) imageUrls.add(avatarUrl);
  }

  try {
    const galleryResources = await listCloudinaryGalleryResources();
    for (const resource of galleryResources) {
      const secureUrl = normalizeImageUrl(resource?.secure_url || resource?.url);
      if (secureUrl && extractCloudinaryPublicId(secureUrl)) imageUrls.add(secureUrl);
    }
  } catch (err) {
    console.error('Cloudinary gallery cleanup prefetch failed:', err instanceof Error ? err.message : String(err));
  }

  try {
    const storeResources = await listCloudinaryStoreResources();
    for (const resource of storeResources) {
      const secureUrl = normalizeImageUrl(resource?.secure_url || resource?.url);
      if (!secureUrl || !extractCloudinaryPublicId(secureUrl)) continue;
      rawUrls.add(secureUrl);
    }
  } catch (err) {
    console.error('Cloudinary store cleanup prefetch failed:', err instanceof Error ? err.message : String(err));
  }

  let deletedImages = 0;
  let deletedVideos = 0;
  let deletedRaw = 0;
  const failures = [];

  for (const imageUrl of imageUrls) {
    try {
      await destroyCloudinaryImageByUrl(imageUrl);
      deletedImages += 1;
    } catch (err) {
      failures.push({
        resource_type: 'image',
        url: imageUrl,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  for (const videoUrl of videoUrls) {
    try {
      await destroyCloudinaryVideoByUrl(videoUrl);
      deletedVideos += 1;
    } catch (err) {
      failures.push({
        resource_type: 'video',
        url: videoUrl,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  for (const rawUrl of rawUrls) {
    try {
      await destroyCloudinaryAssetByUrl(rawUrl, 'raw');
      deletedRaw += 1;
    } catch (err) {
      failures.push({
        resource_type: 'raw',
        url: rawUrl,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    deleted_images: deletedImages,
    deleted_videos: deletedVideos,
    deleted_raw: deletedRaw,
    failed: failures,
  };
}

function parseResetAdminKeepInput(input) {
  const body = input && typeof input === 'object' ? input : {};
  const userId =
    parsePositiveNumber(body.keep_admin_user_id) ||
    parsePositiveNumber(body.admin_user_id) ||
    parsePositiveNumber(body.user_id) ||
    null;
  const nickname =
    normalizeText(body.keep_admin_nickname, 40) ||
    normalizeText(body.admin_nickname, 40) ||
    normalizeText(body.nickname, 40) ||
    null;
  return { userId, nickname };
}

function sanitizeAdminProfileForReset(profileInput, fallbackUserId, fallbackNickname) {
  const profile = profileInput && typeof profileInput === 'object' ? profileInput : {};
  const userId = parsePositiveNumber(profile.user_id) || parsePositiveNumber(fallbackUserId) || 1;
  const nickname = normalizeText(profile.nickname, 40) || normalizeText(fallbackNickname, 40) || 'admin';
  const now = nowIso();
  return {
    user_id: userId,
    nickname,
    name: normalizeText(profile.name, 80) || 'Admin',
    bio: normalizeText(profile.bio, 300) || null,
    avatar_url: normalizeAvatarUrl(profile.avatar_url),
    privacy: {
      watchlist: false,
      favorites: false,
      watched: false,
      rated: false,
      favorite_actors: false,
      favorite_directors: false,
    },
    watchlist: [],
    favorites: [],
    watched: [],
    rated: [],
    favorite_actors: [],
    favorite_directors: [],
    updated_at: now,
  };
}

function resolveAdminProfileToKeepOnReset(input) {
  const { userId, nickname } = parseResetAdminKeepInput(input);
  const profiles = Object.values(store.users || {}).filter((row) => row && typeof row === 'object');

  let matched = null;
  if (userId) {
    matched = profiles.find((row) => parsePositiveNumber(row.user_id) === userId) || null;
  }
  if (!matched && nickname) {
    const target = nickname.toLowerCase();
    matched = profiles.find((row) => String(row.nickname || '').trim().toLowerCase() === target) || null;
  }
  if (!matched) {
    matched = profiles.find((row) => String(row.nickname || '').trim().toLowerCase() === 'admin') || null;
  }

  const fallbackUserId = userId || parsePositiveNumber(matched?.user_id) || 1;
  const fallbackNickname = nickname || normalizeText(matched?.nickname, 40) || 'admin';
  return sanitizeAdminProfileForReset(matched, fallbackUserId, fallbackNickname);
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
  const userId = resolveCanonicalUserId(input?.user_id ?? input?.userId) || parsePositiveNumber(input?.user_id ?? input?.userId) || null;
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

function resetAllStoreData(adminProfileInput = null) {
  const adminProfile =
    adminProfileInput && typeof adminProfileInput === 'object'
      ? sanitizeAdminProfileForReset(
          adminProfileInput,
          parsePositiveNumber(adminProfileInput.user_id) || 1,
          normalizeText(adminProfileInput.nickname, 40) || 'admin'
        )
      : null;
  store.idSeq = 1;
  store.userIdSeq = (parsePositiveNumber(adminProfile?.user_id) || 0) + 1;
  store.items = [];
  store.cinemaPollIdSeq = 1;
  store.cinemaPollCurrent = null;
  store.commentIdSeq = 1;
  store.comments = [];
  store.users = adminProfile ? { [String(adminProfile.user_id)]: adminProfile } : {};
  store.localAuth = {};
  store.userAliases = {};
  store.userSessions = {};
  store.follows = {};
  store.movieStates = {};
  store.galleryIdSeq = 1;
  store.galleryCommentIdSeq = 1;
  store.galleryItems = [];
  store.galleryLikes = [];
  store.galleryFavorites = [];
  store.galleryComments = [];
  store.pushTokenIdSeq = 1;
  store.pushTokens = [];
  store.pushState = {
    notified_live_event_ids: [],
    notified_poll_ids: [],
  };
  saveStore(store);
  return adminProfile;
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
    const pollClosedByExpiry = closeExpiredCinemaPoll();
    if (pollClosedByExpiry) {
      saveStore(store);
    }
    void notifyCinemaLiveStartedPushIfNeeded()
      .then((changed) => {
        if (changed) saveStore(store);
      })
      .catch((err) => {
        console.warn('Live push notify failed:', err instanceof Error ? err.message : String(err));
      });
    if (
      pathname === '/api/gallery' ||
      pathname.startsWith('/api/gallery/') ||
      pathname.endsWith('/gallery-favorites')
    ) {
      void ensureStoredGalleryItemsTaggedInCloudinary();
      await ensureGalleryHydratedFromCloudinary();
      if (normalizeGalleryStoreInPlace()) {
        saveStore(store);
      }
    }

    if (method === 'GET' && pathname === '/health') {
      return json(res, 200, { ok: true, now: nowIso(), events: store.items.length });
    }

    if (method === 'GET' && pathname === '/api/auth/local/nickname-available') {
      const nickname = normalizeText(url.searchParams.get('nickname'), 40);
      const excludeUserId =
        resolveCanonicalUserId(url.searchParams.get('exclude_user_id') || url.searchParams.get('excludeUserId')) ||
        parsePositiveNumber(url.searchParams.get('exclude_user_id') || url.searchParams.get('excludeUserId'));
      if (!nickname || nickname.length < 3 || nickname.length > 20 || !LOCAL_NICKNAME_RE.test(nickname)) {
        return json(res, 200, { available: false });
      }
      const takenByAuth = findLocalAuthEntryByNickname(nickname);
      if (takenByAuth && takenByAuth.user_id !== excludeUserId) {
        return json(res, 200, { available: false });
      }
      const takenByProfileUserId = findCanonicalUserIdByNickname(nickname);
      if (takenByProfileUserId && takenByProfileUserId !== excludeUserId) {
        return json(res, 200, { available: false });
      }
      return json(res, 200, { available: true });
    }

    if (method === 'POST' && pathname === '/api/auth/local/register') {
      const body = await readBody(req);
      const nickname = validateLocalNickname(body?.nickname);
      const password = validateLocalPassword(body?.password);
      const existingByNickname = findLocalAuthEntryByNickname(nickname);
      if (existingByNickname) {
        return json(res, 409, { error: 'Nickname already used.' });
      }
      const existingProfileUserId = findCanonicalUserIdByNickname(nickname);
      if (existingProfileUserId) {
        return json(res, 409, {
          error: 'Account already exists on backend. Login once from original device to sync password.',
        });
      }

      const canonicalUserId = allocateCanonicalUserId();
      const profile = ensureUserProfile(canonicalUserId, nickname);
      profile.name = normalizeText(body?.name, 80) || profile.name || null;
      profile.updated_at = nowIso();
      upsertLocalAuthEntry(canonicalUserId, nickname, password);
      const session = upsertUserSession(canonicalUserId, null);
      saveStore(store);
      return json(res, 201, {
        ok: true,
        user: serializeLocalAuthUser(canonicalUserId),
        session_token: session.token,
        canonical_user_id: canonicalUserId,
      });
    }

    if (method === 'POST' && pathname === '/api/auth/local/login') {
      const body = await readBody(req);
      const nickname = validateLocalNickname(body?.nickname);
      const password = validateLocalPassword(body?.password);
      const auth = findLocalAuthEntryByNickname(nickname);
      if (!auth) {
        const existingProfileUserId = findCanonicalUserIdByNickname(nickname);
        if (existingProfileUserId) {
          const authByUser = getLocalAuthEntryByUserId(existingProfileUserId);
          if (authByUser) {
            const passwordHashByUser = hashLocalPassword(password);
            if (passwordHashByUser !== authByUser.password_hash) {
              return json(res, 401, { error: 'Wrong nickname or password.' });
            }
            const canonicalByUser = resolveCanonicalUserId(existingProfileUserId) || existingProfileUserId;
            ensureUserProfile(canonicalByUser, nickname);
            syncLocalAuthNicknameForUser(canonicalByUser, nickname);
            const sessionByUser = upsertUserSession(canonicalByUser, null);
            saveStore(store);
            return json(res, 200, {
              ok: true,
              user: serializeLocalAuthUser(canonicalByUser),
              session_token: sessionByUser.token,
              canonical_user_id: canonicalByUser,
            });
          }
          return json(res, 404, {
            error: 'Account exists on backend but password is not synced yet. Login once from original device and retry.',
          });
        }
        return json(res, 404, { error: 'Account not found.' });
      }
      const passwordHash = hashLocalPassword(password);
      if (passwordHash !== auth.password_hash) {
        return json(res, 401, { error: 'Wrong nickname or password.' });
      }
      const canonicalUserId = resolveCanonicalUserId(auth.user_id) || auth.user_id;
      const profile = ensureUserProfile(canonicalUserId, null);
      const profileNickname = normalizeText(profile?.nickname, 40);
      const profileNickKey = nicknameKey(profileNickname);
      const loginNickKey = nicknameKey(nickname);
      const authNickKey = nicknameKey(auth.nickname);
      if (profileNickKey && profileNickKey !== authNickKey) {
        const synced = syncLocalAuthNicknameForUser(canonicalUserId, profileNickname);
        if (synced && profileNickKey !== loginNickKey) {
          saveStore(store);
          return json(res, 404, { error: 'Nickname changed. Use your current nickname.' });
        }
      } else {
        ensureUserProfile(canonicalUserId, auth.nickname);
        syncLocalAuthNicknameForUser(canonicalUserId, auth.nickname);
      }
      const session = upsertUserSession(canonicalUserId, null);
      saveStore(store);
      return json(res, 200, {
        ok: true,
        user: serializeLocalAuthUser(canonicalUserId),
        session_token: session.token,
        canonical_user_id: canonicalUserId,
      });
    }

    if (method === 'POST' && pathname === '/api/auth/local/sync') {
      const body = await readBody(req);
      const requestedUserId =
        resolveCanonicalUserId(body?.user_id ?? body?.userId) || parsePositiveNumber(body?.user_id ?? body?.userId);
      if (!requestedUserId) {
        return json(res, 400, { error: 'user_id is required.' });
      }
      const sessionCheck = requireUserSession(req, requestedUserId);
      if (!sessionCheck.ok) {
        return json(res, sessionCheck.status, { error: sessionCheck.error });
      }
      const nickname = validateLocalNickname(body?.nickname);
      const password = validateLocalPassword(body?.password);
      const canonicalUserId = resolveCanonicalUserId(sessionCheck.userId) || sessionCheck.userId;
      const takenByNickname = findLocalAuthEntryByNickname(nickname);
      if (takenByNickname && takenByNickname.user_id !== canonicalUserId) {
        return json(res, 409, { error: 'Nickname already used.' });
      }
      ensureUserProfile(canonicalUserId, nickname);
      upsertLocalAuthEntry(canonicalUserId, nickname, password);
      const session = upsertUserSession(canonicalUserId, null);
      saveStore(store);
      return json(res, 200, {
        ok: true,
        user: serializeLocalAuthUser(canonicalUserId),
        session_token: session.token,
        canonical_user_id: canonicalUserId,
      });
    }

    if (method === 'GET' && pathname === '/api/cinema/latest') {
      return json(res, 200, { event: getLatestEvent() });
    }

    if (method === 'GET' && pathname === '/api/cinema/current') {
      const now = url.searchParams.get('now') || nowIso();
      return json(res, 200, { event: getCurrentEvent(now) });
    }

    if (method === 'GET' && pathname === '/api/cinema/poll/current') {
      const userId = parsePositiveNumber(url.searchParams.get('user_id'));
      const poll = serializeCinemaPollForUser(store.cinemaPollCurrent, userId || null);
      return json(res, 200, { poll });
    }

    if (method === 'POST' && pathname === '/api/cinema/poll') {
      if (!isAuthorizedAdmin(req)) {
        return json(res, 401, { error: 'Unauthorized admin request.' });
      }
      const body = await readBody(req);
      const poll = createCinemaPoll(body);
      try {
        await notifyCinemaPollOpenedPush(poll);
      } catch (err) {
        console.warn('Poll push notify failed:', err instanceof Error ? err.message : String(err));
      }
      saveStore(store);
      return json(res, 201, { poll: serializeCinemaPollForUser(poll, null) });
    }

    if (method === 'POST' && /^\/api\/cinema\/poll\/\d+\/vote$/.test(pathname)) {
      const parts = pathname.split('/').filter(Boolean);
      const pollId = parsePositiveNumber(parts[3]);
      if (!pollId) return json(res, 400, { error: 'Invalid poll id.' });
      const body = await readBody(req);
      const userId = parsePositiveNumber(body?.user_id);
      const optionId = normalizeText(body?.option_id, 20).toLowerCase();
      if (!userId) return json(res, 400, { error: 'user_id is required.' });
      if (!optionId) return json(res, 400, { error: 'option_id is required.' });
      const poll = voteCinemaPoll(pollId, userId, optionId);
      saveStore(store);
      return json(res, 200, { poll: serializeCinemaPollForUser(poll, userId) });
    }

    if (method === 'POST' && /^\/api\/cinema\/poll\/\d+\/close$/.test(pathname)) {
      if (!isAuthorizedAdmin(req)) {
        return json(res, 401, { error: 'Unauthorized admin request.' });
      }
      const parts = pathname.split('/').filter(Boolean);
      const pollId = parsePositiveNumber(parts[3]);
      if (!pollId) return json(res, 400, { error: 'Invalid poll id.' });
      const poll = closeCinemaPoll(pollId);
      if (!poll) return json(res, 404, { error: 'Cinema poll not found.' });
      saveStore(store);
      return json(res, 200, { poll: serializeCinemaPollForUser(poll, null) });
    }

    if (method === 'POST' && pathname === '/api/media/cloudinary/sign-upload') {
      const body = await readBody(req);
      const adminAuthorized = isAuthorizedAdmin(req);
      const requestedUserId = parsePositiveNumber(body?.user_id ?? body?.userId);
      const canonicalRequestedUserId =
        resolveCanonicalUserId(requestedUserId) || parsePositiveNumber(requestedUserId) || null;
      let activeSession = null;
      let activeUserId = canonicalRequestedUserId;
      if (!adminAuthorized) {
        const sessionCheck = requireUserSession(req, canonicalRequestedUserId);
        if (!sessionCheck.ok) {
          return json(res, sessionCheck.status, { error: sessionCheck.error });
        }
        activeUserId = resolveCanonicalUserId(sessionCheck.userId) || sessionCheck.userId;
        activeSession = getUserSession(activeUserId);
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
              user_id: activeUserId,
              folder: 'movie-rec-avatars',
            }
      );
      if (activeSession?.token) {
        return json(res, 200, { ...payload, session_token: activeSession.token, canonical_user_id: activeUserId });
      }
      return json(res, 200, { ...payload, canonical_user_id: activeUserId });
    }

    if (method === 'POST' && pathname === '/api/media/cloudinary/delete-image') {
      const body = await readBody(req);
      const imageUrl = String(body?.image_url || '').trim();
      const userId = resolveCanonicalUserId(body?.user_id ?? body?.userId) || parsePositiveNumber(body?.user_id ?? body?.userId);
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
      if (store.cinemaPollCurrent && store.cinemaPollCurrent.status === 'open') {
        store.cinemaPollCurrent.status = 'closed';
        store.cinemaPollCurrent.updated_at = nowIso();
      }
      saveStore(store);
      return json(res, 201, { event });
    }

    if (method === 'POST' && pathname === '/api/users/session/bootstrap') {
      const body = await readBody(req);
      const requestedUserId = parsePositiveNumber(body?.user_id ?? body?.userId);
      const nickname = normalizeText(body?.nickname, 40);
      if (!requestedUserId) {
        return json(res, 400, { error: 'user_id is required.' });
      }
      if (!nickname) {
        return json(res, 400, { error: 'nickname is required.' });
      }
      const canonicalUserId =
        resolveCanonicalUserIdForNickname(requestedUserId, nickname) ||
        resolveCanonicalUserId(requestedUserId) ||
        requestedUserId;
      if (canonicalUserId !== requestedUserId) {
        setUserAlias(requestedUserId, canonicalUserId);
        mergeUserIntoCanonicalUserId(requestedUserId, canonicalUserId);
      }
      ensureUserProfile(canonicalUserId, nickname);
      const session = upsertUserSession(canonicalUserId, null);
      saveStore(store);
      return json(res, 200, { ok: true, session_token: session.token, canonical_user_id: canonicalUserId });
    }

    if (method === 'POST' && pathname === '/api/users/profile-sync') {
      const body = await readBody(req);
      const clean = normalizeProfileSync(body);
      const canonicalByNickname = resolveCanonicalUserIdForNickname(clean.user_id, clean.nickname);
      const canonicalUserId = canonicalByNickname || resolveCanonicalUserId(clean.user_id) || clean.user_id;
      if (canonicalUserId !== clean.user_id) {
        setUserAlias(clean.user_id, canonicalUserId);
        mergeUserIntoCanonicalUserId(clean.user_id, canonicalUserId);
      }
      clean.user_id = canonicalUserId;
      let activeSession = getUserSession(canonicalUserId);
      const existingProfile = store.users[String(canonicalUserId)];
      const prevNickname = normalizeText(existingProfile?.nickname, 40) || '';
      if (activeSession) {
        const token = getUserTokenFromRequest(req);
        if (!token || token !== activeSession.token) {
          const existingNickname = String(existingProfile?.nickname || '').trim().toLowerCase();
          const requestedNickname = String(clean.nickname || '').trim().toLowerCase();
          if (!existingNickname || existingNickname !== requestedNickname) {
            return json(res, 403, { error: 'Invalid user session token.' });
          }
          activeSession = upsertUserSession(canonicalUserId, null);
        }
      } else {
        if (existingProfile) {
          const existingNickname = String(existingProfile.nickname || '').trim().toLowerCase();
          const requestedNickname = String(clean.nickname || '').trim().toLowerCase();
          if (!existingNickname || existingNickname !== requestedNickname) {
            return json(res, 403, { error: 'Profile sync requires matching nickname for first session bootstrap.' });
          }
        }
        activeSession = upsertUserSession(canonicalUserId, null);
      }
      store.users[String(canonicalUserId)] = mergeUserProfiles(clean, existingProfile, canonicalUserId);
      syncLocalAuthNicknameForUser(canonicalUserId, clean.nickname);
      syncStoredCommentIdentityForUser(canonicalUserId, prevNickname, clean.nickname, clean.avatar_url);
      saveStore(store);
      return json(res, 200, {
        ok: true,
        profile: publicProfileView(canonicalUserId),
        session_token: activeSession.token,
        canonical_user_id: canonicalUserId,
      });
    }

    if (method === 'DELETE' && /^\/api\/users\/\d+$/.test(pathname)) {
      const parts = pathname.split('/').filter(Boolean);
      const requestedUserId = resolveCanonicalUserId(parts[2]) || parsePositiveNumber(parts[2]);
      if (!requestedUserId) return json(res, 400, { error: 'Invalid user id.' });

      const sessionCheck = requireUserSession(req, requestedUserId);
      if (!sessionCheck.ok) {
        return json(res, sessionCheck.status, { error: sessionCheck.error });
      }

      const deletion = deleteUserAccountFromStore(sessionCheck.userId);
      const avatarCleanup = {
        deleted: [],
        failed: [],
      };
      for (const avatarUrl of deletion.avatar_urls) {
        try {
          await destroyCloudinaryImageByUrl(avatarUrl);
          avatarCleanup.deleted.push(avatarUrl);
        } catch (err) {
          avatarCleanup.failed.push({
            avatar_url: avatarUrl,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      saveStore(store);
      return json(res, 200, {
        ok: true,
        deleted_user_id: deletion.deleted_user_id,
        deleted_alias_ids: deletion.deleted_alias_ids,
        avatar_cleanup: avatarCleanup,
      });
    }

    if (method === 'GET' && pathname.startsWith('/api/users/') && pathname.endsWith('/public')) {
      const parts = pathname.split('/').filter(Boolean);
      const userId = resolveCanonicalUserId(parts[2]) || Number(parts[2] || 0);
      const profile = publicProfileView(userId);
      return json(res, 200, { profile });
    }

    if (method === 'POST' && pathname.startsWith('/api/users/') && pathname.endsWith('/follow')) {
      const parts = pathname.split('/').filter(Boolean);
      const targetId = resolveCanonicalUserId(parts[2]) || Number(parts[2] || 0);
      const body = await readBody(req);
      const followerId = resolveCanonicalUserId(body?.follower_id) || Number(body?.follower_id);
      if (!Number.isFinite(followerId) || followerId <= 0) {
        return json(res, 400, { error: 'follower_id is required.' });
      }
      followUser(followerId, targetId);
      saveStore(store);
      return json(res, 200, { ok: true });
    }

    if (method === 'DELETE' && pathname.startsWith('/api/users/') && pathname.endsWith('/follow')) {
      const parts = pathname.split('/').filter(Boolean);
      const targetId = resolveCanonicalUserId(parts[2]) || Number(parts[2] || 0);
      const followerId = resolveCanonicalUserId(url.searchParams.get('follower_id')) || Number(url.searchParams.get('follower_id') || 0);
      if (!Number.isFinite(followerId) || followerId <= 0) {
        return json(res, 400, { error: 'follower_id is required.' });
      }
      unfollowUser(followerId, targetId);
      saveStore(store);
      return json(res, 200, { ok: true });
    }

    if (method === 'GET' && pathname.startsWith('/api/users/') && pathname.endsWith('/following')) {
      const parts = pathname.split('/').filter(Boolean);
      const userId = resolveCanonicalUserId(parts[2]) || Number(parts[2] || 0);
      const ids = Array.isArray(store.follows[String(userId)]) ? store.follows[String(userId)] : [];
      const profiles = ids.map((id) => publicProfileView(id)).filter(Boolean);
      return json(res, 200, { users: profiles });
    }

    if (method === 'GET' && pathname.startsWith('/api/users/') && pathname.endsWith('/favorite-actors')) {
      const parts = pathname.split('/').filter(Boolean);
      const userId = resolveCanonicalUserId(parts[2]) || parsePositiveNumber(parts[2]);
      if (!userId) return json(res, 400, { error: 'Invalid user id.' });
      const profile = ensureUserProfile(userId, null);
      profile.favorite_actors = normalizePersonFavorites(profile.favorite_actors, 300);
      return json(res, 200, { items: profile.favorite_actors });
    }

    if (method === 'POST' && pathname.startsWith('/api/users/') && pathname.endsWith('/favorite-actors/toggle')) {
      const parts = pathname.split('/').filter(Boolean);
      const userId = resolveCanonicalUserId(parts[2]) || parsePositiveNumber(parts[2]);
      if (!userId) return json(res, 400, { error: 'Invalid user id.' });
      const body = await readBody(req);
      const personId = parsePositiveNumber(body?.person_id ?? body?.personId);
      if (!personId) return json(res, 400, { error: 'person_id is required.' });
      const active = togglePersonFavoriteEntry(userId, 'favorite_actors', personId);
      saveStore(store);
      return json(res, 200, { ok: true, active });
    }

    if (method === 'GET' && pathname.startsWith('/api/users/') && pathname.endsWith('/favorite-directors')) {
      const parts = pathname.split('/').filter(Boolean);
      const userId = resolveCanonicalUserId(parts[2]) || parsePositiveNumber(parts[2]);
      if (!userId) return json(res, 400, { error: 'Invalid user id.' });
      const profile = ensureUserProfile(userId, null);
      profile.favorite_directors = normalizePersonFavorites(profile.favorite_directors, 300);
      return json(res, 200, { items: profile.favorite_directors });
    }

    if (method === 'POST' && pathname.startsWith('/api/users/') && pathname.endsWith('/favorite-directors/toggle')) {
      const parts = pathname.split('/').filter(Boolean);
      const userId = resolveCanonicalUserId(parts[2]) || parsePositiveNumber(parts[2]);
      if (!userId) return json(res, 400, { error: 'Invalid user id.' });
      const body = await readBody(req);
      const personId = parsePositiveNumber(body?.person_id ?? body?.personId);
      if (!personId) return json(res, 400, { error: 'person_id is required.' });
      const active = togglePersonFavoriteEntry(userId, 'favorite_directors', personId);
      saveStore(store);
      return json(res, 200, { ok: true, active });
    }

    if (method === 'GET' && pathname.startsWith('/api/users/') && pathname.endsWith('/movie-state')) {
      const parts = pathname.split('/').filter(Boolean);
      const userId = resolveCanonicalUserId(parts[2]) || parsePositiveNumber(parts[2]);
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
      const userId = resolveCanonicalUserId(parts[2]) || parsePositiveNumber(parts[2]);
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
      const userId = resolveCanonicalUserId(parts[2]) || parsePositiveNumber(parts[2]);
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
      const userId = resolveCanonicalUserId(parts[2]) || parsePositiveNumber(parts[2]);
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
      const userId = resolveCanonicalUserId(parts[2]) || parsePositiveNumber(parts[2]);
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
      const userId = resolveCanonicalUserId(parts[2]) || parsePositiveNumber(parts[2]);
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
      const userId = resolveCanonicalUserId(parts[2]) || parsePositiveNumber(parts[2]);
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
      const userId = resolveCanonicalUserId(url.searchParams.get('user_id')) || parsePositiveNumber(url.searchParams.get('user_id')) || 0;
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
      const normalizedIncoming = normalizeGalleryItemForStore(clean);
      if (!normalizedIncoming) {
        return json(res, 400, { error: 'Invalid gallery payload.' });
      }

      const incomingKey = galleryItemIdentityKey(normalizedIncoming);
      const existingIndex = store.galleryItems.findIndex(
        (row) => galleryItemIdentityKey(row) === incomingKey
      );
      let itemId = null;
      let created = false;

      if (existingIndex >= 0) {
        const existing = normalizeGalleryItemForStore(store.galleryItems[existingIndex]);
        const existingScore = galleryItemQualityScore(existing || store.galleryItems[existingIndex]);
        const incomingScore = galleryItemQualityScore(normalizedIncoming);
        if (incomingScore > existingScore) {
          store.galleryItems[existingIndex] = {
            ...store.galleryItems[existingIndex],
            ...normalizedIncoming,
            id: store.galleryItems[existingIndex].id,
            created_at:
              store.galleryItems[existingIndex].created_at || normalizedIncoming.created_at || nowIso(),
          };
        }
        itemId = parsePositiveNumber(store.galleryItems[existingIndex]?.id) || null;
      } else {
        const item = {
          id: store.galleryIdSeq++,
          ...normalizedIncoming,
        };
        store.galleryItems.push(item);
        itemId = item.id;
        created = true;
      }

      store.galleryItems = normalizeAndDedupeGalleryItems(store.galleryItems);
      store.galleryIdSeq =
        store.galleryItems.reduce((acc, row) => Math.max(acc, parsePositiveNumber(row?.id) || 0), 0) + 1;
      const validIds = new Set(
        store.galleryItems
          .map((row) => parsePositiveNumber(row?.id))
          .filter((id) => !!id)
      );
      store.galleryLikes = dedupeByKey(
        store.galleryLikes.filter((row) => validIds.has(parsePositiveNumber(row?.gallery_id))),
        (row) => `${parsePositiveNumber(row?.user_id) || 0}:${parsePositiveNumber(row?.gallery_id) || 0}`
      );
      store.galleryFavorites = dedupeByKey(
        store.galleryFavorites.filter((row) => validIds.has(parsePositiveNumber(row?.gallery_id))),
        (row) => `${parsePositiveNumber(row?.user_id) || 0}:${parsePositiveNumber(row?.gallery_id) || 0}`
      );
      store.galleryComments = store.galleryComments.filter((row) =>
        validIds.has(parsePositiveNumber(row?.gallery_id))
      );
      store.galleryCommentIdSeq =
        store.galleryComments.reduce((acc, row) => Math.max(acc, parsePositiveNumber(row?.id) || 0), 0) + 1;

      let item = getGalleryItemById(itemId);
      if (!item) {
        item =
          store.galleryItems.find((row) => galleryItemIdentityKey(row) === incomingKey) || null;
      }
      if (!item) {
        return json(res, 500, { error: 'Failed to persist gallery item.' });
      }

      try {
        await tagCloudinaryAssetAsGallery(item);
      } catch (err) {
        console.warn(
          'Cloudinary gallery tagging skipped:',
          err instanceof Error ? err.message : String(err)
        );
      }
      saveStore(store);
      const userId = resolveCanonicalUserId(body?.user_id) || parsePositiveNumber(body?.user_id) || 0;
      return json(res, created ? 201 : 200, { item: serializeGalleryItemForFeed(item, userId) });
    }

    if (method === 'DELETE' && /^\/api\/gallery\/\d+$/.test(pathname)) {
      const parts = pathname.split('/').filter(Boolean);
      const galleryId = parsePositiveNumber(parts[2]);
      if (!galleryId) return json(res, 400, { error: 'Invalid gallery id.' });
      const targetItem = getGalleryItemById(galleryId);
      if (!targetItem) {
        return json(res, 404, { error: 'Gallery item not found.' });
      }
      let cleanup = { deleted_images: 0 };
      let cleanupError = null;
      try {
        cleanup = await cleanupGalleryItemCloudinaryMedia(targetItem);
      } catch (err) {
        cleanupError = err instanceof Error ? err.message : String(err);
        console.warn(
          `Gallery media cleanup failed for item ${galleryId}:`,
          cleanupError
        );
      }
      store.galleryItems = store.galleryItems.filter((item) => Number(item.id) !== galleryId);
      store.galleryLikes = store.galleryLikes.filter((row) => Number(row.gallery_id) !== galleryId);
      store.galleryFavorites = store.galleryFavorites.filter((row) => Number(row.gallery_id) !== galleryId);
      store.galleryComments = store.galleryComments.filter((row) => Number(row.gallery_id) !== galleryId);
      saveStore(store);
      return json(res, 200, { ok: true, cleanup, cleanup_error: cleanupError });
    }

    if (method === 'POST' && /^\/api\/gallery\/\d+\/toggle-like$/.test(pathname)) {
      const parts = pathname.split('/').filter(Boolean);
      const galleryId = parsePositiveNumber(parts[2]);
      if (!galleryId) return json(res, 400, { error: 'Invalid gallery id.' });
      if (!getGalleryItemById(galleryId)) return json(res, 404, { error: 'Gallery item not found.' });
      const body = await readBody(req);
      const userId = resolveCanonicalUserId(body?.user_id) || parsePositiveNumber(body?.user_id);
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
      const userId = resolveCanonicalUserId(body?.user_id) || parsePositiveNumber(body?.user_id);
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
      if (comment.parent_id) {
        const parentRow = store.galleryComments.find((row) => Number(row.id) === Number(comment.parent_id));
        if (parentRow) {
          try {
            await notifyCommentReplyPush('gallery', comment, parentRow);
          } catch (err) {
            console.warn('Gallery reply push failed:', err instanceof Error ? err.message : String(err));
          }
        }
      }
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

    if (method === 'GET' && pathname === '/api/notifications/replies') {
      const userId =
        resolveCanonicalUserId(url.searchParams.get('user_id')) ||
        parsePositiveNumber(url.searchParams.get('user_id'));
      if (!userId) {
        return json(res, 400, { error: 'user_id is required.' });
      }
      const replies = collectReplyNotificationsForUser(userId, {
        since: url.searchParams.get('since'),
        limit: url.searchParams.get('limit'),
      });
      return json(res, 200, { replies });
    }

    if (method === 'POST' && pathname === '/api/notifications/push/register') {
      const body = await readBody(req);
      const userId =
        resolveCanonicalUserId(body?.user_id ?? body?.userId) ||
        parsePositiveNumber(body?.user_id ?? body?.userId);
      if (!userId) {
        return json(res, 400, { error: 'user_id is required.' });
      }
      const sessionCheck = requireUserSession(req, userId);
      if (!sessionCheck.ok) {
        return json(res, sessionCheck.status, { error: sessionCheck.error });
      }
      const expoPushToken = normalizeExpoPushToken(body?.expo_push_token ?? body?.token);
      if (!expoPushToken) {
        return json(res, 400, { error: 'expo_push_token is invalid.' });
      }
      const record = upsertPushTokenRecord({
        userId: sessionCheck.userId,
        expoPushToken,
        platform: body?.platform,
        deviceName: body?.device_name ?? body?.deviceName,
      });
      if (!record) {
        return json(res, 400, { error: 'Could not register push token.' });
      }
      saveStore(store);
      return json(res, 200, {
        ok: true,
        token_id: Number(record.id),
        user_id: Number(record.user_id),
      });
    }

    if (method === 'POST' && pathname === '/api/notifications/push/unregister') {
      const body = await readBody(req);
      const userId =
        resolveCanonicalUserId(body?.user_id ?? body?.userId) ||
        parsePositiveNumber(body?.user_id ?? body?.userId);
      if (!userId) {
        return json(res, 400, { error: 'user_id is required.' });
      }
      const sessionCheck = requireUserSession(req, userId);
      if (!sessionCheck.ok) {
        return json(res, sessionCheck.status, { error: sessionCheck.error });
      }
      const expoPushToken = normalizeExpoPushToken(body?.expo_push_token ?? body?.token);
      if (!expoPushToken) {
        return json(res, 400, { error: 'expo_push_token is invalid.' });
      }
      const removed = removePushTokenRecord(sessionCheck.userId, expoPushToken);
      if (removed > 0) {
        saveStore(store);
      }
      return json(res, 200, { ok: true, removed });
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
      if (comment.parent_id) {
        const parentRow = store.comments.find((row) => Number(row.id) === Number(comment.parent_id));
        if (parentRow) {
          try {
            await notifyCommentReplyPush('movie', comment, parentRow);
          } catch (err) {
            console.warn('Movie reply push failed:', err instanceof Error ? err.message : String(err));
          }
        }
      }
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
      const body = await readBody(req);
      const keptAdmin = resolveAdminProfileToKeepOnReset(body);
      const cleanup = await cleanupAllStoreCloudinaryMedia({ preserveUserIds: [keptAdmin.user_id] });
      if (cleanup.failed.length) {
        return json(res, 502, {
          error: 'Cloudinary cleanup failed. Reset aborted.',
          cleanup,
        });
      }
      const kept = resetAllStoreData(keptAdmin);
      try {
        await forceCloudStoreSyncFromStore();
      } catch (err) {
        return json(res, 502, {
          error: err instanceof Error ? err.message : 'Cloudinary store sync failed.',
          cleanup,
        });
      }
      return json(res, 200, {
        ok: true,
        cleanup,
        kept_admin: kept
          ? {
              user_id: kept.user_id,
              nickname: kept.nickname,
            }
          : null,
      });
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

function viewerKeyFor(ws) {
  if (Number.isFinite(ws?.user?.userId) && ws.user.userId > 0) {
    return `u:${ws.user.userId}`;
  }
  if (ws?.user?.clientId) {
    return `c:${ws.user.clientId}`;
  }
  return `g:${ws.sessionId}`;
}

function connectionKeyFor(ws) {
  if (!ws) return '';
  if (ws?.user?.clientId) {
    return `c:${ws.user.clientId}`;
  }
  if (Number.isFinite(ws?.user?.userId) && ws.user.userId > 0) {
    return `u:${ws.user.userId}`;
  }
  return `g:${ws.sessionId || ''}`;
}

function removeDuplicateRoomClients(room, currentWs) {
  if (!room || !currentWs) return;
  const currentKey = connectionKeyFor(currentWs);
  if (!currentKey || currentKey.startsWith('g:')) return;

  room.clients.forEach((client) => {
    if (client === currentWs) return;
    if (connectionKeyFor(client) !== currentKey) return;
    room.clients.delete(client);
    try {
      client.close(4001, 'Duplicate cinema connection replaced.');
    } catch {
      try {
        client.terminate();
      } catch {
      }
    }
  });
}

function roomViewerCount(room) {
  const viewers = new Set();
  room.clients.forEach((client) => viewers.add(viewerKeyFor(client)));
  return viewers.size;
}

function broadcastRoomStats(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  const payload = {
    type: 'stats',
    room: roomId,
    viewers: roomViewerCount(room),
    likes: room.likes.size,
  };
  room.clients.forEach((client) => safeSend(client, payload));
}

wss.on('connection', (ws) => {
  ws.sessionId = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  ws.room = null;
  ws.user = { userId: null, nickname: 'guest', avatarUrl: null, clientId: null };

  ws.on('message', (raw) => {
    try {
      const data = JSON.parse(String(raw));
      if (data.type === 'join' && data.room) {
        if (ws.room) {
          const prevRoom = rooms.get(ws.room);
          if (prevRoom) {
            prevRoom.clients.delete(ws);
            broadcastRoomStats(ws.room);
          }
        }
        const roomId = String(data.room);
        const room = getRoom(roomId);
        room.clients.add(ws);
        ws.room = roomId;
        ws.user = {
          userId: Number.isFinite(Number(data.userId)) ? Number(data.userId) : null,
          nickname: normalizeText(data.nickname, 40) || 'guest',
          avatarUrl: normalizeAvatarUrl(data.avatarUrl),
          clientId: normalizeText(data.client_id ?? data.clientId, 80) || null,
        };
        removeDuplicateRoomClients(room, ws);
        safeSend(ws, {
          type: 'history',
          room: roomId,
          messages: room.messages.slice(-80).map((message) => ({
            ...message,
            avatarUrl: normalizeAvatarUrl(message?.avatarUrl),
          })),
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
        const key = viewerKeyFor(ws);
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
    const key = viewerKeyFor(ws);
    const hasSibling = Array.from(room.clients).some((client) => viewerKeyFor(client) === key);
    if (!hasSibling) {
      room.likes.delete(key);
    }
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

let livePushCheckInProgress = false;
async function runLivePushCheck() {
  if (livePushCheckInProgress) return;
  livePushCheckInProgress = true;
  try {
    const changed = await notifyCinemaLiveStartedPushIfNeeded();
    if (changed) {
      saveStore(store);
    }
  } catch (err) {
    console.warn('Live push check failed:', err instanceof Error ? err.message : String(err));
  } finally {
    livePushCheckInProgress = false;
  }
}

setInterval(() => {
  void runLivePushCheck();
}, LIVE_PUSH_CHECK_INTERVAL_MS);

async function startServer() {
  await restoreStoreFromCloudinaryBackup();
  maintainCanonicalUserMappings();
  await runLivePushCheck();
  saveStore(store);
  registerShutdownSyncHandlers();
  server.listen(port, () => {
    console.log(`Cinema backend running on http://localhost:${port}`);
    console.log(
      `REST:  GET /health, GET /api/cinema/current, GET /api/cinema/latest, GET /api/cinema/poll/current, GET /api/notifications/replies, POST /api/notifications/push/register, POST /api/notifications/push/unregister, POST /api/cinema/poll, POST /api/cinema/poll/:id/vote, POST /api/cinema/events`
    );
    console.log(`WS:    ws://localhost:${port}/ws`);
  });
}

startServer().catch((err) => {
  console.error('Backend startup failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
