from __future__ import annotations

import os
from threading import Lock
from typing import Literal

import pandas as pd
from fastapi import FastAPI, Query
from pydantic import BaseModel
from sqlalchemy import create_engine, text

from train import RecoArtifacts, explain_recommendation, recommend, train_artifacts


DATABASE_URL = os.getenv("ML_DATABASE_URL", "sqlite:///./ml_local.db")

app = FastAPI(title="MovieRec ML Service", version="1.0.0")
engine = create_engine(DATABASE_URL, future=True)

_model_lock = Lock()
_artifacts_by_media: dict[str, RecoArtifacts] = {}
_rows_loaded_by_media: dict[str, int] = {"movie": 0, "tv": 0}


class RecommendationItem(BaseModel):
    tmdb_id: int
    score: float
    reason: str


class RecommendationResponse(BaseModel):
    user_id: int
    media_type: Literal["movie", "tv"]
    model_rows: int
    items: list[RecommendationItem]


class ExplainScoreParts(BaseModel):
    user_knn: float
    item_knn: float
    svd: float
    follow_taste: float
    popularity: float


class NeighborUser(BaseModel):
    user_id: int
    similarity: float
    interaction_score: float


class SimilarSeenItem(BaseModel):
    tmdb_id: int
    similarity: float
    user_strength: float


class ExplainResponse(BaseModel):
    user_id: int
    tmdb_id: int
    media_type: Literal["movie", "tv"]
    model_rows: int
    already_seen: bool
    final_score: float
    score_parts: ExplainScoreParts
    top_neighbor_users: list[NeighborUser]
    similar_seen_items: list[SimilarSeenItem]


class InteractionIn(BaseModel):
    user_id: int
    tmdb_id: int
    media_type: Literal["movie", "tv"]
    event_type: Literal["watchlist", "watched", "favorite", "rating", "favorite_actor"]
    event_value: float | None = None
    occurred_at: str | None = None


class FollowSyncIn(BaseModel):
    follower_id: int
    following_ids: list[int]


def _ensure_tables():
    backend = engine.url.get_backend_name()
    with engine.begin() as conn:
        if backend == "sqlite":
            conn.execute(
                text(
                    """
                    CREATE TABLE IF NOT EXISTS app_users (
                      id INTEGER PRIMARY KEY,
                      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                    )
                    """
                )
            )
            conn.execute(
                text(
                    """
                    CREATE TABLE IF NOT EXISTS user_interactions (
                      id INTEGER PRIMARY KEY AUTOINCREMENT,
                      user_id INTEGER NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
                      tmdb_id INTEGER NOT NULL,
                      media_type TEXT NOT NULL CHECK (media_type IN ('movie', 'tv')),
                      event_type TEXT NOT NULL CHECK (event_type IN ('watched', 'favorite', 'watchlist', 'rating', 'favorite_actor')),
                      event_value REAL,
                      occurred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                    )
                    """
                )
            )
            conn.execute(
                text(
                    """
                    CREATE TABLE IF NOT EXISTS user_follows (
                      follower_id INTEGER NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
                      followee_id INTEGER NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
                      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                      PRIMARY KEY (follower_id, followee_id)
                    )
                    """
                )
            )
        else:
            conn.execute(
                text(
                    """
                    CREATE TABLE IF NOT EXISTS app_users (
                      id BIGINT PRIMARY KEY,
                      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                    )
                    """
                )
            )
            conn.execute(
                text(
                    """
                    CREATE TABLE IF NOT EXISTS user_interactions (
                      id BIGSERIAL PRIMARY KEY,
                      user_id BIGINT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
                      tmdb_id BIGINT NOT NULL,
                      media_type TEXT NOT NULL CHECK (media_type IN ('movie', 'tv')),
                      event_type TEXT NOT NULL CHECK (event_type IN ('watched', 'favorite', 'watchlist', 'rating', 'favorite_actor')),
                      event_value DOUBLE PRECISION,
                      occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                    )
                    """
                )
            )
            conn.execute(
                text(
                    """
                    CREATE TABLE IF NOT EXISTS user_follows (
                      follower_id BIGINT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
                      followee_id BIGINT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
                      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                      PRIMARY KEY (follower_id, followee_id)
                    )
                    """
                )
            )


def _load_interactions(media_type: str) -> pd.DataFrame:
    sql = text(
        """
        SELECT user_id, tmdb_id, media_type, event_type, event_value, occurred_at
        FROM user_interactions
        WHERE media_type = :media_type
        """
    )
    with engine.begin() as conn:
        df = pd.read_sql(sql, conn, params={"media_type": media_type})
    return df


def _load_follows() -> pd.DataFrame:
    sql = text(
        """
        SELECT follower_id, followee_id
        FROM user_follows
        """
    )
    with engine.begin() as conn:
        df = pd.read_sql(sql, conn)
    return df


def _ensure_model(media_type: str) -> RecoArtifacts:
    with _model_lock:
        cached = _artifacts_by_media.get(media_type)
        if cached is not None:
            return cached
        df = _load_interactions(media_type)
        _rows_loaded_by_media[media_type] = int(len(df))
        follows_df = _load_follows()
        artifacts = train_artifacts(df, follows=follows_df)
        _artifacts_by_media[media_type] = artifacts
        return artifacts


def _invalidate_model(media_type: str | None = None):
    with _model_lock:
        if media_type is None:
            _artifacts_by_media.clear()
            return
        _artifacts_by_media.pop(media_type, None)


@app.get("/health")
def health():
    return {"ok": True}


@app.on_event("startup")
def _startup():
    _ensure_tables()


@app.post("/ingest")
def ingest_one(payload: InteractionIn):
    with engine.begin() as conn:
        conn.execute(
            text("INSERT INTO app_users (id) VALUES (:uid) ON CONFLICT (id) DO NOTHING"),
            {"uid": payload.user_id},
        )
        conn.execute(
            text(
                """
                INSERT INTO user_interactions
                  (user_id, tmdb_id, media_type, event_type, event_value, occurred_at)
                VALUES
                  (:user_id, :tmdb_id, :media_type, :event_type, :event_value, COALESCE(:occurred_at, CURRENT_TIMESTAMP))
                """
            ),
            payload.model_dump(),
        )
    _invalidate_model(payload.media_type)
    return {"ok": True}


@app.post("/ingest/batch")
def ingest_batch(payload: list[InteractionIn]):
    if not payload:
        return {"ok": True, "count": 0}
    rows = [item.model_dump() for item in payload]
    user_ids = sorted({row["user_id"] for row in rows})
    with engine.begin() as conn:
        for uid in user_ids:
            conn.execute(
                text("INSERT INTO app_users (id) VALUES (:uid) ON CONFLICT (id) DO NOTHING"),
                {"uid": uid},
            )
        conn.execute(
            text(
                """
                INSERT INTO user_interactions
                  (user_id, tmdb_id, media_type, event_type, event_value, occurred_at)
                VALUES
                  (:user_id, :tmdb_id, :media_type, :event_type, :event_value, COALESCE(:occurred_at, CURRENT_TIMESTAMP))
                """
            ),
            rows,
        )
    changed_types = {row["media_type"] for row in rows}
    for mt in changed_types:
        _invalidate_model(str(mt))
    return {"ok": True, "count": len(rows)}


@app.post("/follows/sync")
def sync_follows(payload: FollowSyncIn):
    follower_id = int(payload.follower_id)
    if follower_id <= 0:
        return {"ok": False, "error": "follower_id is required"}
    clean_following = sorted({int(x) for x in payload.following_ids if int(x) > 0 and int(x) != follower_id})

    with engine.begin() as conn:
        conn.execute(
            text("INSERT INTO app_users (id) VALUES (:uid) ON CONFLICT (id) DO NOTHING"),
            {"uid": follower_id},
        )
        for followee_id in clean_following:
            conn.execute(
                text("INSERT INTO app_users (id) VALUES (:uid) ON CONFLICT (id) DO NOTHING"),
                {"uid": followee_id},
            )

        conn.execute(
            text("DELETE FROM user_follows WHERE follower_id = :follower_id"),
            {"follower_id": follower_id},
        )
        for followee_id in clean_following:
            conn.execute(
                text(
                    """
                    INSERT INTO user_follows (follower_id, followee_id)
                    VALUES (:follower_id, :followee_id)
                    ON CONFLICT (follower_id, followee_id) DO NOTHING
                    """
                ),
                {"follower_id": follower_id, "followee_id": followee_id},
            )

    _invalidate_model(None)
    return {"ok": True, "count": len(clean_following)}


@app.post("/train")
def train(media_type: Literal["movie", "tv"] = Query(default="movie")):
    with _model_lock:
        df = _load_interactions(media_type)
        follows_df = _load_follows()
        _rows_loaded_by_media[media_type] = int(len(df))
        _artifacts_by_media[media_type] = train_artifacts(df, follows=follows_df)
    return {"ok": True, "rows": _rows_loaded_by_media[media_type], "media_type": media_type}


@app.get("/recommendations/{user_id}", response_model=RecommendationResponse)
def recommendations(
    user_id: int,
    media_type: Literal["movie", "tv"] = Query(default="movie"),
    top_n: int = Query(default=20, ge=1, le=100),
):
    artifacts = _ensure_model(media_type)
    rows = recommend(artifacts, user_id=user_id, top_n=top_n)
    items = [RecommendationItem(tmdb_id=tmdb_id, score=score, reason=reason) for tmdb_id, score, reason in rows]
    return RecommendationResponse(
        user_id=user_id,
        media_type=media_type,
        model_rows=_rows_loaded_by_media.get(media_type, 0),
        items=items,
    )


@app.get("/explain/{user_id}/{tmdb_id}", response_model=ExplainResponse)
def explain(
    user_id: int,
    tmdb_id: int,
    media_type: Literal["movie", "tv"] = Query(default="movie"),
):
    artifacts = _ensure_model(media_type)
    payload = explain_recommendation(artifacts, user_id=user_id, tmdb_id=tmdb_id)
    return ExplainResponse(
        user_id=payload["user_id"],
        tmdb_id=payload["tmdb_id"],
        media_type=media_type,
        model_rows=_rows_loaded_by_media.get(media_type, 0),
        already_seen=payload["already_seen"],
        final_score=payload["final_score"],
        score_parts=payload["score_parts"],
        top_neighbor_users=payload["top_neighbor_users"],
        similar_seen_items=payload["similar_seen_items"],
    )
