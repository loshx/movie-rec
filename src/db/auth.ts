import * as Crypto from 'expo-crypto';
import * as SQLite from 'expo-sqlite';
import Constants from 'expo-constants';
import { getDb } from './database';
import { ADMIN_LOCAL_LOGIN, ADMIN_LOCAL_PASSWORD } from '@/constants/auth';

export type User = {
  id: number;
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

const NICKNAME_RE = /^[a-zA-Z0-9._-]+$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function nowIso() {
  return new Date().toISOString();
}

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

function loginIdentity(nickname: string) {
  return nickname.trim().toLowerCase();
}

function lockSecondsForFailures(failedCount: number) {
  if (failedCount < 5) return 0;
  const exp = Math.min(10, failedCount - 5);
  return Math.min(3600, 30 * 2 ** exp);
}

async function checkLoginGuardOrThrow(db: SQLite.SQLiteDatabase, identity: string) {
  const row = await db.getFirstAsync<{ failed_count: number; locked_until: string | null }>(
    'SELECT failed_count, locked_until FROM auth_login_attempts WHERE identity = ?',
    identity
  );
  if (!row?.locked_until) return;
  const lockedUntil = Date.parse(row.locked_until);
  if (Number.isNaN(lockedUntil)) return;
  const now = Date.now();
  if (lockedUntil > now) {
    const waitSec = Math.ceil((lockedUntil - now) / 1000);
    throw new Error(`Too many attempts. Try again in ${waitSec}s.`);
  }
}

async function markLoginFailure(db: SQLite.SQLiteDatabase, identity: string) {
  const existing = await db.getFirstAsync<{ failed_count: number }>(
    'SELECT failed_count FROM auth_login_attempts WHERE identity = ?',
    identity
  );
  const nextFailed = (existing?.failed_count ?? 0) + 1;
  const lockSec = lockSecondsForFailures(nextFailed);
  const lockedUntil = lockSec > 0 ? new Date(Date.now() + lockSec * 1000).toISOString() : null;
  await db.runAsync(
    `
    INSERT INTO auth_login_attempts (identity, failed_count, locked_until, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(identity) DO UPDATE SET
      failed_count = excluded.failed_count,
      locked_until = excluded.locked_until,
      updated_at = excluded.updated_at
    `,
    identity,
    nextFailed,
    lockedUntil,
    nowIso()
  );
}

async function clearLoginGuard(db: SQLite.SQLiteDatabase, identity: string) {
  await db.runAsync('DELETE FROM auth_login_attempts WHERE identity = ?', identity);
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

async function generateUniqueNickname(db: SQLite.SQLiteDatabase, base: string) {
  let candidate = base || 'user';
  let suffix = 0;
  while (true) {
    const exists = await db.getFirstAsync<{ ok: number }>(
      'SELECT 1 as ok FROM users WHERE LOWER(nickname) = LOWER(?)',
      candidate
    );
    if (!exists) return candidate;
    suffix += 1;
    candidate = `${base || 'user'}${suffix}`;
  }
}

async function hashPassword(password: string) {
  return Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    password
  );
}

export async function ensureDefaultAdmin() {
  const db = await getDb();
  const existing = await db.getFirstAsync<User>(
    "SELECT * FROM users WHERE role = 'admin' LIMIT 1"
  );
  const adminPasswordHash = await hashPassword(ADMIN_LOCAL_PASSWORD);
  const createdAt = nowIso();
  if (existing) {
    await db.runAsync(
      `
      UPDATE users
      SET nickname = ?, password_hash = ?, auth_provider = 'local', updated_at = ?
      WHERE id = ?
      `,
      ADMIN_LOCAL_LOGIN,
      adminPasswordHash,
      createdAt,
      existing.id
    );
    return;
  }

  const passwordHash = adminPasswordHash;

  await db.runAsync(
    `
    INSERT INTO users
      (name, nickname, email, date_of_birth, country, bio, avatar_url, password_hash, role, auth_provider, google_sub, created_at, updated_at)
    VALUES
      (?, ?, ?, ?, ?, NULL, NULL, ?, ?, 'auth0', NULL, ?, ?)
    `,
    'Admin',
    ADMIN_LOCAL_LOGIN,
    null,
    null,
    null,
    passwordHash,
    'admin',
    createdAt,
    createdAt
  );
}

export async function registerUser(payload: RegisterPayload): Promise<User> {
  const db = await getDb();
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

  const existing = await db.getFirstAsync<User>(
    'SELECT * FROM users WHERE LOWER(nickname) = LOWER(?)',
    nickname
  );

  if (existing) {
    throw new Error('Nickname already used.');
  }

  const passwordHash = await hashPassword(payload.password);
  const createdAt = nowIso();

  const result = await db.runAsync(
    `
    INSERT INTO users
      (name, nickname, email, date_of_birth, country, bio, avatar_url, password_hash, role, auth_provider, google_sub, created_at, updated_at)
    VALUES
      (?, ?, ?, ?, ?, NULL, NULL, ?, ?, 'local', NULL, ?, ?)
    `,
    payload.name?.trim() || null,
    nickname,
    email || null,
    dateOfBirth || null,
    payload.country?.trim() || null,
    passwordHash,
    'user',
    createdAt,
    createdAt
  );

  const user = await db.getFirstAsync<User>(
    'SELECT * FROM users WHERE id = ?',
    result.lastInsertRowId
  );

  if (!user) {
    throw new Error('Failed to create user.');
  }

  await db.runAsync(
    'INSERT OR REPLACE INTO auth_sessions (id, user_id, created_at) VALUES (1, ?, ?)',
    user.id,
    nowIso()
  );

  return user;
}

export async function isNicknameAvailable(nickname: string, excludeUserId?: number): Promise<boolean> {
  const db = await getDb();
  const clean = nickname.trim();
  if (!clean) return false;

  const existing = typeof excludeUserId === 'number'
    ? await db.getFirstAsync<{ ok: number }>(
        'SELECT 1 as ok FROM users WHERE LOWER(nickname) = LOWER(?) AND id != ?',
        clean,
        excludeUserId
      )
    : await db.getFirstAsync<{ ok: number }>(
        'SELECT 1 as ok FROM users WHERE LOWER(nickname) = LOWER(?)',
        clean
      );

  return !existing;
}

export async function loginUser(nickname: string, password: string): Promise<User> {
  const db = await getDb();
  const cleanNickname = nickname.trim();
  const identity = loginIdentity(cleanNickname);

  if (!cleanNickname || !password) {
    throw new Error('Nickname and password are required.');
  }

  await checkLoginGuardOrThrow(db, identity);

  const user = await db.getFirstAsync<User>(
    'SELECT * FROM users WHERE LOWER(nickname) = LOWER(?)',
    cleanNickname
  );

  if (!user) {
    await markLoginFailure(db, identity);
    throw new Error('Wrong nickname or password.');
  }
  const passwordHash = await hashPassword(password);

  const match = await db.getFirstAsync<{ ok: number }>(
    'SELECT 1 as ok FROM users WHERE id = ? AND password_hash = ?',
    user.id,
    passwordHash
  );

  if (!match) {
    await markLoginFailure(db, identity);
    throw new Error('Wrong nickname or password.');
  }

  await clearLoginGuard(db, identity);

  await db.runAsync(
    'INSERT OR REPLACE INTO auth_sessions (id, user_id, created_at) VALUES (1, ?, ?)',
    user.id,
    nowIso()
  );

  return user;
}

export async function upsertAuth0User(profile: OAuthProfile): Promise<User> {
  const db = await getDb();
  const sub = profile.sub;
  const email = profile.email?.trim() || null;
  const name = profile.name?.trim() || null;

  const existing = await db.getFirstAsync<User>(
    'SELECT * FROM users WHERE google_sub = ?',
    sub
  );
  const shouldBeAdmin = ADMIN_AUTH0_SUBS.has(sub) || (!!email && ADMIN_EMAILS.has(email.toLowerCase()));
  const targetRole: 'user' | 'admin' = shouldBeAdmin ? 'admin' : 'user';

  if (existing) {
    await db.runAsync(
      `UPDATE users SET email = ?, name = ?, role = ?, auth_provider = 'auth0', updated_at = ? WHERE id = ?`,
      email,
      name,
      targetRole,
      nowIso(),
      existing.id
    );
    await db.runAsync(
      'INSERT OR REPLACE INTO auth_sessions (id, user_id, created_at) VALUES (1, ?, ?)',
      existing.id,
      nowIso()
    );
    return { ...existing, email, name, role: targetRole, auth_provider: 'auth0', updated_at: nowIso() };
  }

  const base = slugify(
    (email && email.split('@')[0]) ||
      profile.given_name ||
      profile.family_name ||
      name ||
      'user'
  );
  const nickname = await generateUniqueNickname(db, base);

  const passwordHash = await hashPassword(`${sub}:${nowIso()}`);
  const createdAt = nowIso();

  const result = await db.runAsync(
    `
    INSERT INTO users
      (name, nickname, email, date_of_birth, country, bio, avatar_url, password_hash, role, auth_provider, google_sub, created_at, updated_at)
    VALUES
      (?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, 'auth0', ?, ?, ?)
    `,
    name,
    nickname,
    email,
    passwordHash,
    targetRole,
    sub,
    createdAt,
    createdAt
  );

  const user = await db.getFirstAsync<User>(
    'SELECT * FROM users WHERE id = ?',
    result.lastInsertRowId
  );

  if (!user) {
    throw new Error('Failed to create Google user.');
  }

  await db.runAsync(
    'INSERT OR REPLACE INTO auth_sessions (id, user_id, created_at) VALUES (1, ?, ?)',
    user.id,
    nowIso()
  );

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
  const db = await getDb();
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
  const currentUser = await db.getFirstAsync<User>('SELECT * FROM users WHERE id = ?', userId);
  if (!currentUser) throw new Error('User not found.');
  if (nickname && isReservedAdminNickname(nickname) && currentUser.role !== 'admin') {
    throw new Error('This nickname is reserved.');
  }

  if (nickname) {
    const existing = await db.getFirstAsync<User>(
      'SELECT * FROM users WHERE LOWER(nickname) = LOWER(?) AND id != ?',
      nickname,
      userId
    );
    if (existing) {
      throw new Error('Nickname already used.');
    }
  }

  await db.runAsync(
    `UPDATE users SET name = ?, email = ?, date_of_birth = ?, country = ?, nickname = COALESCE(?, nickname), bio = ?, avatar_url = ?, updated_at = ? WHERE id = ?`,
    name,
    email,
    dateOfBirth,
    country,
    nickname,
    bio,
    avatarUrl,
    nowIso(),
    userId
  );

  const updated = await db.getFirstAsync<User>('SELECT * FROM users WHERE id = ?', userId);
  if (!updated) throw new Error('User not found.');
  return updated;
}

export async function resetDatabaseKeepAdminOnly() {
  const db = await getDb();
  await ensureDefaultAdmin();

  await db.execAsync(`
    DELETE FROM auth_sessions;
    DELETE FROM user_comments;
    DELETE FROM user_movies;
    DELETE FROM user_watchlist;
    DELETE FROM user_favorites;
    DELETE FROM user_favorite_actors;
    DELETE FROM user_favorite_directors;
    DELETE FROM user_ratings;
    DELETE FROM user_watched;
    DELETE FROM user_list_privacy;
    DELETE FROM user_search_history;
    DELETE FROM user_search_clicks;
    DELETE FROM gallery_comments;
    DELETE FROM gallery_likes;
    DELETE FROM gallery_favorites;
    DELETE FROM gallery_items;
    DELETE FROM featured_movie;
    DELETE FROM cinema_events;
    DELETE FROM users WHERE role != 'admin';
  `);

  const admin = await db.getFirstAsync<User>(
    "SELECT * FROM users WHERE role = 'admin' LIMIT 1"
  );
  if (!admin) return;
  await db.runAsync(
    'INSERT OR REPLACE INTO auth_sessions (id, user_id, created_at) VALUES (1, ?, ?)',
    admin.id,
    nowIso()
  );
}

export async function getCurrentUser(): Promise<User | null> {
  const db = await getDb();
  return db.getFirstAsync<User>(
    `
    SELECT u.* FROM users u
    INNER JOIN auth_sessions s ON s.user_id = u.id
    WHERE s.id = 1
    `
  );
}

export async function logoutUser() {
  const db = await getDb();
  await db.runAsync('DELETE FROM auth_sessions WHERE id = 1');
}
