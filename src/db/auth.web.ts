import * as Crypto from 'expo-crypto';
import Constants from 'expo-constants';
import { ADMIN_LOCAL_LOGIN, ADMIN_LOCAL_PASSWORD } from '@/constants/auth';
import type { BackendLocalAuthUser } from '@/lib/local-auth-backend';

export type User = {
  id: number;
  backend_user_id: number | null;
  name: string | null;
  nickname: string;
  email: string | null;
  date_of_birth: string | null;
  country: string | null;
  bio: string | null;
  avatar_url: string | null;
  role: 'user' | 'admin';
  auth_provider: 'local' | 'google' | 'auth0';
  google_sub: string | null;
  created_at: string;
  updated_at: string;
};

type RegisterPayload = {
  name?: string;
  nickname: string;
  email?: string;
  dateOfBirth?: string;
  country?: string;
  password: string;
  role?: 'user' | 'admin';
};

type OAuthProfile = {
  sub: string;
  email?: string | null;
  name?: string | null;
  given_name?: string | null;
  family_name?: string | null;
};

type WebUser = User & { password_hash: string };

type WebState = {
  users: WebUser[];
  sessionUserId: number | null;
  idSeq: number;
  loginGuards: Record<string, { failedCount: number; lockedUntil: string | null; updatedAt: string }>;
};

const STORAGE_KEY = 'movie_rec_auth_state';

function loadState(): WebState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { users: [], sessionUserId: null, idSeq: 1, loginGuards: {} };
    const parsed = JSON.parse(raw) as WebState;
    const users = (parsed.users ?? []).map((user) => ({
      ...user,
      backend_user_id:
        Number.isFinite(Number((user as any)?.backend_user_id)) && Number((user as any)?.backend_user_id) > 0
          ? Number((user as any)?.backend_user_id)
          : null,
    }));
    return {
      users,
      sessionUserId: parsed.sessionUserId ?? null,
      idSeq: parsed.idSeq ?? 1,
      loginGuards: parsed.loginGuards ?? {},
    };
  } catch {
    return { users: [], sessionUserId: null, idSeq: 1, loginGuards: {} };
  }
}

function saveState(state: WebState) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
  }
}

const webState: WebState = loadState();

const extra = (Constants.expoConfig?.extra ?? {}) as {
  EXPO_PUBLIC_ADMIN_AUTH0_SUBS?: string;
  EXPO_PUBLIC_ADMIN_EMAILS?: string;
};
const ADMIN_AUTH0_SUBS = new Set(
  String(extra.EXPO_PUBLIC_ADMIN_AUTH0_SUBS ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
);
const ADMIN_EMAILS = new Set(
  String(extra.EXPO_PUBLIC_ADMIN_EMAILS ?? '')
    .split(',')
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean)
);

const NICKNAME_RE = /^[a-zA-Z0-9._-]+$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function nowIso() {
  return new Date().toISOString();
}

function isValidDateString(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return false;
  return date.toISOString().slice(0, 10) === value;
}

function validateNickname(nickname: string) {
  if (!nickname) throw new Error('Nickname is required.');
  if (nickname.length < 3 || nickname.length > 20) {
    throw new Error('Nickname must be 3-20 characters.');
  }
  if (!NICKNAME_RE.test(nickname)) {
    throw new Error('Nickname can contain only letters, numbers, ".", "_" or "-".');
  }
}

function isReservedAdminNickname(nickname: string) {
  const clean = nickname.trim().toLowerCase();
  return clean === 'admin' || clean === ADMIN_LOCAL_LOGIN.toLowerCase();
}

function loginIdentity(nickname: string) {
  return nickname.trim().toLowerCase();
}

function lockSecondsForFailures(failedCount: number) {
  if (failedCount < 5) return 0;
  const exp = Math.min(10, failedCount - 5);
  return Math.min(3600, 30 * 2 ** exp);
}

function checkLoginGuardOrThrow(identity: string) {
  const row = webState.loginGuards[identity];
  if (!row?.lockedUntil) return;
  const lockedUntil = Date.parse(row.lockedUntil);
  if (Number.isNaN(lockedUntil)) return;
  const now = Date.now();
  if (lockedUntil > now) {
    const waitSec = Math.ceil((lockedUntil - now) / 1000);
    throw new Error(`Too many attempts. Try again in ${waitSec}s.`);
  }
}

function markLoginFailure(identity: string) {
  const prev = webState.loginGuards[identity];
  const nextFailed = (prev?.failedCount ?? 0) + 1;
  const lockSec = lockSecondsForFailures(nextFailed);
  webState.loginGuards[identity] = {
    failedCount: nextFailed,
    lockedUntil: lockSec > 0 ? new Date(Date.now() + lockSec * 1000).toISOString() : null,
    updatedAt: nowIso(),
  };
  saveState(webState);
}

function clearLoginGuard(identity: string) {
  delete webState.loginGuards[identity];
  saveState(webState);
}

function pruneUserScopedRecordKeys<T>(record: Record<string, T>, userId: number) {
  const out: Record<string, T> = {};
  const exact = String(userId);
  const prefix = `${userId}:`;
  for (const [key, value] of Object.entries(record ?? {})) {
    if (key === exact || key.startsWith(prefix)) continue;
    out[key] = value;
  }
  return out;
}

function purgeDeletedUserFromWebStores(userId: number) {
  const userIdStr = String(userId);

  try {
    const raw = localStorage.getItem('movie_rec_user_movies');
    if (raw) {
      const parsed = JSON.parse(raw) as {
        watchlist?: Record<string, boolean>;
        favorites?: Record<string, boolean>;
        favoriteActors?: Record<string, boolean>;
        favoriteDirectors?: Record<string, boolean>;
        watched?: Record<string, boolean>;
        privacy?: Record<string, unknown>;
        watchlistMediaType?: Record<string, 'movie' | 'tv'>;
        favoritesMediaType?: Record<string, 'movie' | 'tv'>;
        watchedMediaType?: Record<string, 'movie' | 'tv'>;
        ratingsMediaType?: Record<string, 'movie' | 'tv'>;
        ratings?: Record<string, number>;
        comments?: Array<{ user_id?: number }>;
      };
      const next = {
        ...parsed,
        watchlist: pruneUserScopedRecordKeys(parsed.watchlist ?? {}, userId),
        favorites: pruneUserScopedRecordKeys(parsed.favorites ?? {}, userId),
        favoriteActors: pruneUserScopedRecordKeys(parsed.favoriteActors ?? {}, userId),
        favoriteDirectors: pruneUserScopedRecordKeys(parsed.favoriteDirectors ?? {}, userId),
        watched: pruneUserScopedRecordKeys(parsed.watched ?? {}, userId),
        privacy: pruneUserScopedRecordKeys(parsed.privacy ?? {}, userId),
        watchlistMediaType: pruneUserScopedRecordKeys(parsed.watchlistMediaType ?? {}, userId),
        favoritesMediaType: pruneUserScopedRecordKeys(parsed.favoritesMediaType ?? {}, userId),
        watchedMediaType: pruneUserScopedRecordKeys(parsed.watchedMediaType ?? {}, userId),
        ratingsMediaType: pruneUserScopedRecordKeys(parsed.ratingsMediaType ?? {}, userId),
        ratings: pruneUserScopedRecordKeys(parsed.ratings ?? {}, userId),
        comments: Array.isArray(parsed.comments)
          ? parsed.comments.filter((row) => Number(row?.user_id) !== userId)
          : [],
      };
      localStorage.setItem('movie_rec_user_movies', JSON.stringify(next));
    }
  } catch {
  }

  try {
    const raw = localStorage.getItem('movie_rec_gallery_items_v2');
    if (raw) {
      const parsed = JSON.parse(raw) as {
        likes?: Array<{ userId?: number }>;
        favorites?: Array<{ userId?: number }>;
        comments?: Array<{ userId?: number }>;
      };
      const next = {
        ...parsed,
        likes: Array.isArray(parsed.likes) ? parsed.likes.filter((row) => Number(row?.userId) !== userId) : [],
        favorites: Array.isArray(parsed.favorites)
          ? parsed.favorites.filter((row) => Number(row?.userId) !== userId)
          : [],
        comments: Array.isArray(parsed.comments)
          ? parsed.comments.filter((row) => Number(row?.userId) !== userId)
          : [],
      };
      localStorage.setItem('movie_rec_gallery_items_v2', JSON.stringify(next));
    }
  } catch {
  }

  try {
    const raw = localStorage.getItem('movie_rec_search_history');
    if (raw) {
      const parsed = JSON.parse(raw) as { byUser?: Record<string, string[]> };
      if (parsed?.byUser && typeof parsed.byUser === 'object' && userIdStr in parsed.byUser) {
        delete parsed.byUser[userIdStr];
        localStorage.setItem('movie_rec_search_history', JSON.stringify(parsed));
      }
    }
  } catch {
  }

  try {
    const raw = localStorage.getItem('movie_rec_search_click_history');
    if (raw) {
      const parsed = JSON.parse(raw) as { byUser?: Record<string, unknown[]> };
      if (parsed?.byUser && typeof parsed.byUser === 'object' && userIdStr in parsed.byUser) {
        delete parsed.byUser[userIdStr];
        localStorage.setItem('movie_rec_search_click_history', JSON.stringify(parsed));
      }
    }
  } catch {
  }
}

function validatePassword(password: string) {
  if (!password) throw new Error('Password is required.');
  if (password.length < 8) {
    throw new Error('Password must be at least 8 characters.');
  }
}

function validateOptionalEmail(email?: string) {
  if (!email) return;
  if (!EMAIL_RE.test(email)) {
    throw new Error('Invalid email.');
  }
}

function validateOptionalDate(dateOfBirth?: string) {
  if (!dateOfBirth) return;
  if (!isValidDateString(dateOfBirth)) {
    throw new Error('Birth date must be in YYYY-MM-DD format.');
  }
}

function slugify(value: string) {
  const cleaned = value
    .toLowerCase()
    .replace(/\s+/g, '.')
    .replace(/[^a-z0-9._-]/g, '');
  return cleaned.replace(/\.+/g, '.').replace(/^\.|\.$/g, '');
}

function generateUniqueNickname(base: string) {
  let candidate = base || 'user';
  let suffix = 0;
  while (webState.users.some((u) => u.nickname.toLowerCase() === candidate.toLowerCase())) {
    suffix += 1;
    candidate = `${base || 'user'}${suffix}`;
  }
  return candidate;
}

async function hashPassword(password: string) {
  return Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    password
  );
}

export async function ensureDefaultAdmin() {
  const existing = webState.users.find((u) => u.role === 'admin');
  const adminPasswordHash = await hashPassword(ADMIN_LOCAL_PASSWORD);
  const createdAt = nowIso();
  if (existing) {
    existing.backend_user_id =
      Number.isFinite(Number(existing.backend_user_id)) && Number(existing.backend_user_id) > 0
        ? Number(existing.backend_user_id)
        : null;
    existing.nickname = ADMIN_LOCAL_LOGIN;
    existing.password_hash = adminPasswordHash;
    existing.auth_provider = 'local';
    existing.updated_at = createdAt;
    saveState(webState);
    return;
  }

  const passwordHash = adminPasswordHash;

  const user: WebUser = {
    id: webState.idSeq++,
    backend_user_id: null,
    name: 'Admin',
    nickname: ADMIN_LOCAL_LOGIN,
    email: null,
    date_of_birth: null,
    country: null,
    bio: null,
    avatar_url: null,
    password_hash: passwordHash,
    role: 'admin',
    auth_provider: 'local',
    google_sub: null,
    created_at: createdAt,
    updated_at: createdAt,
  };

  webState.users.push(user);
  saveState(webState);
}

export async function registerUser(payload: RegisterPayload): Promise<User> {
  const nickname = payload.nickname.trim();
  const email = payload.email?.trim() || '';
  const dateOfBirth = payload.dateOfBirth?.trim() || '';

  validateNickname(nickname);
  if (isReservedAdminNickname(nickname)) {
    throw new Error('This nickname is reserved.');
  }
  validatePassword(payload.password);
  validateOptionalEmail(email || undefined);
  validateOptionalDate(dateOfBirth || undefined);

  const existing = webState.users.find(
    (u) => u.nickname.toLowerCase() === nickname.toLowerCase()
  );
  if (existing) {
    throw new Error('Nickname already used.');
  }

  const passwordHash = await hashPassword(payload.password);
  const createdAt = nowIso();
  const user: WebUser = {
    id: webState.idSeq++,
    backend_user_id: null,
    name: payload.name?.trim() || null,
    nickname,
    email: email || null,
    date_of_birth: dateOfBirth || null,
    country: payload.country?.trim() || null,
    bio: null,
    avatar_url: null,
    password_hash: passwordHash,
    role: 'user',
    auth_provider: 'local',
    google_sub: null,
    created_at: createdAt,
    updated_at: createdAt,
  };

  webState.users.push(user);
  webState.sessionUserId = user.id;
  saveState(webState);

  return user;
}

export async function isNicknameAvailable(nickname: string, excludeUserId?: number): Promise<boolean> {
  const clean = nickname.trim();
  if (!clean) return false;
  const existing = webState.users.find(
    (u) =>
      u.nickname.toLowerCase() === clean.toLowerCase() &&
      (typeof excludeUserId !== 'number' || u.id !== excludeUserId)
  );
  return !existing;
}

export async function loginUser(nickname: string, password: string): Promise<User> {
  const cleanNickname = nickname.trim();
  const identity = loginIdentity(cleanNickname);

  if (!cleanNickname || !password) {
    throw new Error('Nickname and password are required.');
  }

  checkLoginGuardOrThrow(identity);

  const user = webState.users.find(
    (u) => u.nickname.toLowerCase() === cleanNickname.toLowerCase()
  );
  if (!user) {
    markLoginFailure(identity);
    throw new Error('Wrong nickname or password.');
  }
  const passwordHash = await hashPassword(password);
  if (user.password_hash !== passwordHash) {
    markLoginFailure(identity);
    throw new Error('Wrong nickname or password.');
  }

  clearLoginGuard(identity);
  webState.sessionUserId = user.id;
  saveState(webState);
  return user;
}

export async function upsertLocalUserFromBackend(input: {
  user: BackendLocalAuthUser;
  password: string;
}): Promise<User> {
  const remoteUser = input.user;
  const backendUserId = Number(remoteUser?.user_id);
  if (!Number.isFinite(backendUserId) || backendUserId <= 0) {
    throw new Error('Invalid backend user id.');
  }
  const nickname = String(remoteUser?.nickname || '').trim();
  if (!nickname) {
    throw new Error('Invalid backend user payload.');
  }
  validateNickname(nickname);
  const passwordHash = await hashPassword(String(input.password || ''));
  const now = nowIso();
  const role: 'user' | 'admin' = remoteUser.role === 'admin' ? 'admin' : 'user';
  const authProvider: 'local' | 'google' | 'auth0' =
    remoteUser.auth_provider === 'auth0' ? 'auth0' : remoteUser.auth_provider === 'google' ? 'google' : 'local';
  let existing =
    webState.users.find((u) => Number(u.backend_user_id ?? 0) === backendUserId) || null;
  if (!existing) {
    existing =
      webState.users.find(
        (u) =>
          u.nickname.toLowerCase() === nickname.toLowerCase() &&
          (!Number.isFinite(Number(u.backend_user_id)) || Number(u.backend_user_id) <= 0)
      ) || null;
  }
  if (existing) {
    existing.backend_user_id = backendUserId;
    existing.name = remoteUser.name?.trim() || null;
    existing.nickname = nickname;
    existing.email = remoteUser.email?.trim() || null;
    existing.date_of_birth = remoteUser.date_of_birth?.trim() || null;
    existing.country = remoteUser.country?.trim() || null;
    existing.bio = remoteUser.bio?.trim() || null;
    existing.avatar_url = remoteUser.avatar_url?.trim() || null;
    existing.password_hash = passwordHash;
    existing.role = role;
    existing.auth_provider = authProvider;
    existing.updated_at = now;
    webState.sessionUserId = existing.id;
    clearLoginGuard(loginIdentity(nickname));
    saveState(webState);
    return existing;
  }

  const user: WebUser = {
    id: webState.idSeq++,
    backend_user_id: backendUserId,
    name: remoteUser.name?.trim() || null,
    nickname,
    email: remoteUser.email?.trim() || null,
    date_of_birth: remoteUser.date_of_birth?.trim() || null,
    country: remoteUser.country?.trim() || null,
    bio: remoteUser.bio?.trim() || null,
    avatar_url: remoteUser.avatar_url?.trim() || null,
    password_hash: passwordHash,
    role,
    auth_provider: authProvider,
    google_sub: null,
    created_at: now,
    updated_at: now,
  };
  webState.users.push(user);
  webState.sessionUserId = user.id;
  clearLoginGuard(loginIdentity(nickname));
  saveState(webState);
  return user;
}

export async function upsertAuth0User(profile: OAuthProfile): Promise<User> {
  const sub = profile.sub;
  const email = profile.email?.trim() || null;
  const name = profile.name?.trim() || null;

  const existing = webState.users.find((u) => u.google_sub === sub);
  const shouldBeAdmin = ADMIN_AUTH0_SUBS.has(sub) || (!!email && ADMIN_EMAILS.has(email.toLowerCase()));
  const targetRole: 'user' | 'admin' = shouldBeAdmin ? 'admin' : 'user';
  if (existing) {
    existing.backend_user_id =
      Number.isFinite(Number(existing.backend_user_id)) && Number(existing.backend_user_id) > 0
        ? Number(existing.backend_user_id)
        : null;
    existing.email = email;
    existing.name = name;
    existing.role = targetRole;
    existing.auth_provider = 'auth0';
    existing.updated_at = nowIso();
    webState.sessionUserId = existing.id;
    saveState(webState);
    return existing;
  }

  const base = slugify(
    (email && email.split('@')[0]) ||
      profile.given_name ||
      profile.family_name ||
      name ||
      'user'
  );
  const nickname = generateUniqueNickname(base);
  const passwordHash = await hashPassword(`${sub}:${nowIso()}`);
  const createdAt = nowIso();

  const user: WebUser = {
    id: webState.idSeq++,
    backend_user_id: null,
    name,
    nickname,
    email,
    date_of_birth: null,
    country: null,
    bio: null,
    avatar_url: null,
    password_hash: passwordHash,
    role: targetRole,
    auth_provider: 'auth0',
    google_sub: sub,
    created_at: createdAt,
    updated_at: createdAt,
  };

  webState.users.push(user);
  webState.sessionUserId = user.id;
  saveState(webState);

  return user;
}

export async function updateUserProfile(
  userId: number,
  input: {
    name?: string | null;
    email?: string | null;
    dateOfBirth?: string | null;
    country?: string | null;
    nickname?: string | null;
    bio?: string | null;
    avatarUrl?: string | null;
  }
): Promise<User> {
  const name = input.name?.trim() || null;
  const email = input.email?.trim() || null;
  const dateOfBirth = input.dateOfBirth?.trim() || null;
  const country = input.country?.trim() || null;
  const nickname = input.nickname?.trim() || null;
  const bio = input.bio?.trim() || null;
  const avatarUrl = input.avatarUrl?.trim() || null;

  validateOptionalEmail(email || undefined);
  validateOptionalDate(dateOfBirth || undefined);
  if (nickname) validateNickname(nickname);

  const user = webState.users.find((u) => u.id === userId);
  if (!user) throw new Error('User not found.');
  if (nickname && isReservedAdminNickname(nickname) && user.role !== 'admin') {
    throw new Error('This nickname is reserved.');
  }

  if (nickname) {
    const existing = webState.users.find(
      (u) => u.nickname.toLowerCase() === nickname.toLowerCase() && u.id !== userId
    );
    if (existing) {
      throw new Error('Nickname already used.');
    }
  }

  user.name = name;
  user.email = email;
  user.date_of_birth = dateOfBirth;
  user.country = country;
  if (nickname) user.nickname = nickname;
  user.bio = bio;
  user.avatar_url = avatarUrl;
  user.updated_at = nowIso();

  saveState(webState);
  return user;
}

export async function getCurrentUser(): Promise<User | null> {
  if (!webState.sessionUserId) return null;
  const user = webState.users.find((u) => u.id === webState.sessionUserId);
  return user ?? null;
}

export async function logoutUser() {
  webState.sessionUserId = null;
  saveState(webState);
}

export async function deleteUserAccount(userId: number) {
  const idx = webState.users.findIndex((u) => u.id === userId);
  if (idx < 0) return;
  const user = webState.users[idx];
  if (user.role === 'admin') {
    throw new Error('Admin account cannot be deleted.');
  }
  webState.users.splice(idx, 1);
  if (webState.sessionUserId === userId) {
    webState.sessionUserId = null;
  }
  delete webState.loginGuards[loginIdentity(user.nickname)];
  saveState(webState);
  purgeDeletedUserFromWebStores(userId);
}

export async function resetDatabaseKeepAdminOnly() {
  await ensureDefaultAdmin();
  const admin = webState.users.find((u) => u.role === 'admin');
  if (!admin) return;

  webState.users = [admin];
  webState.sessionUserId = admin.id;
  webState.idSeq = Math.max(admin.id + 1, 2);
  saveState(webState);

  const keys = Object.keys(localStorage);
  for (const key of keys) {
    if (key.startsWith('movie_rec_') && key !== STORAGE_KEY) {
      localStorage.removeItem(key);
    }
  }
}
