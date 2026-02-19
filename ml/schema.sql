-- PostgreSQL schema for ML recommendations service

CREATE TABLE IF NOT EXISTS app_users (
  id BIGINT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_interactions (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  tmdb_id BIGINT NOT NULL,
  media_type TEXT NOT NULL CHECK (media_type IN ('movie', 'tv')),
  event_type TEXT NOT NULL CHECK (event_type IN ('watched', 'favorite', 'watchlist', 'rating', 'favorite_actor')),
  event_value DOUBLE PRECISION,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_interactions_user ON user_interactions(user_id);
CREATE INDEX IF NOT EXISTS idx_interactions_tmdb ON user_interactions(tmdb_id);
CREATE INDEX IF NOT EXISTS idx_interactions_media ON user_interactions(media_type);
CREATE INDEX IF NOT EXISTS idx_interactions_event ON user_interactions(event_type);

-- Useful for fast "already seen" checks
CREATE INDEX IF NOT EXISTS idx_interactions_user_tmdb ON user_interactions(user_id, tmdb_id);

CREATE TABLE IF NOT EXISTS user_follows (
  follower_id BIGINT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  followee_id BIGINT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (follower_id, followee_id)
);

CREATE INDEX IF NOT EXISTS idx_user_follows_follower ON user_follows(follower_id);
