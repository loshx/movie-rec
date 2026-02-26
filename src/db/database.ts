import * as SQLite from 'expo-sqlite';

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

export async function getDb() {
  if (!dbPromise) {
    dbPromise = SQLite.openDatabaseAsync('movie_rec.db');
  }
  return dbPromise;
}

async function ensureColumn(db: SQLite.SQLiteDatabase, table: string, column: string, ddl: string) {
  const columns = await db.getAllAsync<{ name: string }>(`PRAGMA table_info(${table})`);
  const hasColumn = columns.some((col) => col.name === column);
  if (!hasColumn) {
    await db.execAsync(ddl);
  }
}

export async function initDb() {
  const db = await getDb();

  await db.execAsync(`
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      backend_user_id INTEGER,
      name TEXT,
      nickname TEXT NOT NULL UNIQUE,
      email TEXT,
      date_of_birth TEXT,
      country TEXT,
      bio TEXT,
      avatar_url TEXT,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      auth_provider TEXT NOT NULL DEFAULT 'local',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS auth_sessions (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      user_id INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS auth_login_attempts (
      identity TEXT PRIMARY KEY,
      failed_count INTEGER NOT NULL DEFAULT 0,
      locked_until TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_movies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      tmdb_id INTEGER NOT NULL,
      liked INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      UNIQUE(user_id, tmdb_id),
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS user_watchlist (
      user_id INTEGER NOT NULL,
      tmdb_id INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(user_id, tmdb_id),
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS user_favorites (
      user_id INTEGER NOT NULL,
      tmdb_id INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(user_id, tmdb_id),
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS user_favorite_actors (
      user_id INTEGER NOT NULL,
      person_id INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(user_id, person_id),
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS user_favorite_directors (
      user_id INTEGER NOT NULL,
      person_id INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(user_id, person_id),
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS user_ratings (
      user_id INTEGER NOT NULL,
      tmdb_id INTEGER NOT NULL,
      rating INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(user_id, tmdb_id),
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS user_watched (
      user_id INTEGER NOT NULL,
      tmdb_id INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(user_id, tmdb_id),
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS user_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      tmdb_id INTEGER NOT NULL,
      text TEXT NOT NULL,
      parent_id INTEGER,
      created_at TEXT NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY(parent_id) REFERENCES user_comments(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS featured_movie (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      tmdb_id INTEGER,
      title TEXT,
      overview TEXT,
      backdrop_path TEXT,
      poster_path TEXT,
      updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS cinema_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT,
      video_url TEXT NOT NULL,
      poster_url TEXT,
      tmdb_id INTEGER,
      start_at TEXT NOT NULL,
      end_at TEXT NOT NULL,
      created_by INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(created_by) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS gallery_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      image TEXT NOT NULL,
      tag TEXT NOT NULL,
      height INTEGER NOT NULL DEFAULT 240,
      shot_id TEXT,
      title_header TEXT,
      image_id TEXT,
      image_url TEXT,
      palette_json TEXT,
      details_json TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS gallery_likes (
      gallery_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(gallery_id, user_id),
      FOREIGN KEY(gallery_id) REFERENCES gallery_items(id) ON DELETE CASCADE,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS gallery_favorites (
      gallery_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(gallery_id, user_id),
      FOREIGN KEY(gallery_id) REFERENCES gallery_items(id) ON DELETE CASCADE,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS gallery_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      gallery_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      text TEXT NOT NULL,
      parent_id INTEGER,
      created_at TEXT NOT NULL,
      FOREIGN KEY(gallery_id) REFERENCES gallery_items(id) ON DELETE CASCADE,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY(parent_id) REFERENCES gallery_comments(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS user_search_history (
      user_id INTEGER NOT NULL,
      query TEXT NOT NULL,
      last_used_at TEXT NOT NULL,
      PRIMARY KEY(user_id, query),
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS user_search_clicks (
      user_id INTEGER NOT NULL,
      tmdb_id INTEGER NOT NULL,
      media_type TEXT NOT NULL DEFAULT 'movie',
      title TEXT NOT NULL,
      poster_path TEXT,
      vote_average REAL,
      last_used_at TEXT NOT NULL,
      PRIMARY KEY(user_id, tmdb_id, media_type),
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS user_list_privacy (
      user_id INTEGER PRIMARY KEY,
      watchlist INTEGER NOT NULL DEFAULT 0,
      favorites INTEGER NOT NULL DEFAULT 0,
      watched INTEGER NOT NULL DEFAULT 0,
      rated INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_user_movies_user ON user_movies(user_id);
    CREATE INDEX IF NOT EXISTS idx_users_backend_user_id ON users(backend_user_id);
    CREATE INDEX IF NOT EXISTS idx_auth_login_attempts_updated ON auth_login_attempts(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_user_watchlist_user ON user_watchlist(user_id);
    CREATE INDEX IF NOT EXISTS idx_user_favorites_user ON user_favorites(user_id);
    CREATE INDEX IF NOT EXISTS idx_user_favorite_actors_user ON user_favorite_actors(user_id);
    CREATE INDEX IF NOT EXISTS idx_user_favorite_directors_user ON user_favorite_directors(user_id);
    CREATE INDEX IF NOT EXISTS idx_user_ratings_user ON user_ratings(user_id);
    CREATE INDEX IF NOT EXISTS idx_user_watched_user ON user_watched(user_id);
    CREATE INDEX IF NOT EXISTS idx_user_comments_movie ON user_comments(tmdb_id);
    CREATE INDEX IF NOT EXISTS idx_gallery_items_created ON gallery_items(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_gallery_likes_gallery ON gallery_likes(gallery_id);
    CREATE INDEX IF NOT EXISTS idx_gallery_favorites_user ON gallery_favorites(user_id);
    CREATE INDEX IF NOT EXISTS idx_gallery_comments_gallery ON gallery_comments(gallery_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_user_search_history_user ON user_search_history(user_id, last_used_at DESC);
    CREATE INDEX IF NOT EXISTS idx_user_search_clicks_user ON user_search_clicks(user_id, last_used_at DESC);
    CREATE INDEX IF NOT EXISTS idx_cinema_events_start ON cinema_events(start_at DESC);
    CREATE INDEX IF NOT EXISTS idx_user_list_privacy_user ON user_list_privacy(user_id);
  `);

  await ensureColumn(db, 'users', 'google_sub', 'ALTER TABLE users ADD COLUMN google_sub TEXT');
  await ensureColumn(db, 'users', 'backend_user_id', 'ALTER TABLE users ADD COLUMN backend_user_id INTEGER');
  await ensureColumn(db, 'users', 'bio', 'ALTER TABLE users ADD COLUMN bio TEXT');
  await ensureColumn(db, 'users', 'avatar_url', 'ALTER TABLE users ADD COLUMN avatar_url TEXT');
  await ensureColumn(
    db,
    'user_watchlist',
    'media_type',
    "ALTER TABLE user_watchlist ADD COLUMN media_type TEXT NOT NULL DEFAULT 'movie'"
  );
  await ensureColumn(
    db,
    'user_favorites',
    'media_type',
    "ALTER TABLE user_favorites ADD COLUMN media_type TEXT NOT NULL DEFAULT 'movie'"
  );
  await ensureColumn(
    db,
    'user_watched',
    'media_type',
    "ALTER TABLE user_watched ADD COLUMN media_type TEXT NOT NULL DEFAULT 'movie'"
  );
  await ensureColumn(
    db,
    'user_ratings',
    'media_type',
    "ALTER TABLE user_ratings ADD COLUMN media_type TEXT NOT NULL DEFAULT 'movie'"
  );
  await ensureColumn(db, 'cinema_events', 'tmdb_id', 'ALTER TABLE cinema_events ADD COLUMN tmdb_id INTEGER');
  await ensureColumn(db, 'gallery_items', 'shot_id', 'ALTER TABLE gallery_items ADD COLUMN shot_id TEXT');
  await ensureColumn(db, 'gallery_items', 'title_header', 'ALTER TABLE gallery_items ADD COLUMN title_header TEXT');
  await ensureColumn(db, 'gallery_items', 'image_id', 'ALTER TABLE gallery_items ADD COLUMN image_id TEXT');
  await ensureColumn(db, 'gallery_items', 'image_url', 'ALTER TABLE gallery_items ADD COLUMN image_url TEXT');
  await ensureColumn(db, 'gallery_items', 'palette_json', 'ALTER TABLE gallery_items ADD COLUMN palette_json TEXT');
  await ensureColumn(db, 'gallery_items', 'details_json', 'ALTER TABLE gallery_items ADD COLUMN details_json TEXT');
  await ensureColumn(db, 'gallery_comments', 'parent_id', 'ALTER TABLE gallery_comments ADD COLUMN parent_id INTEGER');
}
