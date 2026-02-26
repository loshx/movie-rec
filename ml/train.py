from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List, Set, Tuple

import numpy as np
import pandas as pd
from scipy.sparse import csr_matrix
from sklearn.decomposition import TruncatedSVD
from sklearn.neighbors import NearestNeighbors


EVENT_WEIGHTS = {
    "watchlist": 0.5,
    "watched": 1.0,
    "favorite": 2.0,
    "favorite_actor": 1.65,
}

BLEND_WEIGHTS = {
    "user_knn": 0.34,
    "item_knn": 0.28,
    "svd": 0.20,
    "follow_taste": 0.14,
    "popularity": 0.04,
}

MIN_PERSONAL_SIGNAL = 0.05
PROFILE_SEED_COUNT = 5
PROFILE_NEIGHBOR_COUNT = 35
PROFILE_ITEM_BLEND_WEIGHT = 0.45
RECENCY_HALF_LIFE_DAYS = 240.0
RECENCY_MIN_MULTIPLIER = 0.72
RECENCY_MAX_MULTIPLIER = 1.08


@dataclass
class RecoArtifacts:
    interactions: pd.DataFrame
    user_item: pd.DataFrame
    sparse_matrix: csr_matrix
    user_ids: np.ndarray
    item_ids: np.ndarray
    user_index: Dict[int, int]
    item_index: Dict[int, int]
    knn: NearestNeighbors | None
    item_knn: NearestNeighbors | None
    svd: TruncatedSVD | None
    item_factors: np.ndarray | None
    popularity: pd.Series
    follows_by_follower: Dict[int, Set[int]]


def _event_weight(event_type: str, event_value: float | None) -> float:
    event_type = str(event_type).strip().lower()
    value = None if event_value is None or pd.isna(event_value) else float(event_value)

    if event_type == "rating":
        if value is None or value <= 0:
            return 0.0
        clipped = float(np.clip(value, 0.0, 10.0))
        # Ratings are on a 1..10 scale in app; map to 0..2.
        return clipped / 10.0 * 2.0

    if event_type == "favorite_actor":
        if value is not None and value <= 0:
            return 0.0
        if value is None:
            return EVENT_WEIGHTS[event_type]
        quality = float(np.clip(value, 0.0, 10.0)) / 10.0
        return EVENT_WEIGHTS[event_type] * (0.75 + 0.25 * quality)

    base = float(EVENT_WEIGHTS.get(event_type, 0.0))
    if base <= 0:
        return 0.0
    # For binary events, event_value <= 0 means "disabled"/removed.
    if value is not None and value <= 0:
        return 0.0
    return base


def _recency_multiplier(ts: pd.Timestamp, now_ts: pd.Timestamp) -> float:
    try:
        age_days = max(0.0, float((now_ts - ts).total_seconds()) / 86400.0)
    except Exception:
        return 1.0
    decay = float(np.exp(-age_days / RECENCY_HALF_LIFE_DAYS))
    return float(
        RECENCY_MIN_MULTIPLIER
        + (RECENCY_MAX_MULTIPLIER - RECENCY_MIN_MULTIPLIER) * decay
    )


def _normalize_scores(df: pd.DataFrame) -> pd.DataFrame:
    if df.empty:
        return pd.DataFrame(columns=["user_id", "tmdb_id", "score"])

    work = df.copy()
    for column in ["user_id", "tmdb_id", "event_type", "event_value", "occurred_at"]:
        if column not in work.columns:
            work[column] = np.nan

    work["user_id"] = pd.to_numeric(work["user_id"], errors="coerce")
    work["tmdb_id"] = pd.to_numeric(work["tmdb_id"], errors="coerce")
    work["event_value"] = pd.to_numeric(work["event_value"], errors="coerce")
    work["event_type"] = work["event_type"].astype(str).str.strip().str.lower()
    work = work.dropna(subset=["user_id", "tmdb_id", "event_type"])
    if work.empty:
        return pd.DataFrame(columns=["user_id", "tmdb_id", "score"])

    work["user_id"] = work["user_id"].astype(np.int64)
    work["tmdb_id"] = work["tmdb_id"].astype(np.int64)
    now_ts = pd.Timestamp.now(tz="UTC")
    work["occurred_at"] = pd.to_datetime(work["occurred_at"], errors="coerce", utc=True).fillna(now_ts)

    # Keep only the latest state for each event type on each title.
    work = work.sort_values(
        ["user_id", "tmdb_id", "event_type", "occurred_at"],
        kind="mergesort",
    )
    latest = work.groupby(["user_id", "tmdb_id", "event_type"], as_index=False).tail(1)

    latest["event_weight"] = latest.apply(
        lambda row: _event_weight(str(row["event_type"]), row["event_value"])
        * _recency_multiplier(row["occurred_at"], now_ts),
        axis=1,
    )
    latest = latest[latest["event_weight"] > 0]
    if latest.empty:
        return pd.DataFrame(columns=["user_id", "tmdb_id", "score"])

    grouped = (
        latest.groupby(["user_id", "tmdb_id"], as_index=False)["event_weight"]
        .sum()
        .rename(columns={"event_weight": "score"})
    )
    grouped["score"] = grouped["score"].clip(lower=0.0, upper=6.0)
    return grouped


def train_artifacts(interactions: pd.DataFrame, follows: pd.DataFrame | None = None) -> RecoArtifacts:
    follows_by_follower: Dict[int, Set[int]] = {}
    if follows is not None and not follows.empty:
        for _, row in follows.iterrows():
            try:
                follower = int(row["follower_id"])
                followee = int(row["followee_id"])
            except Exception:
                continue
            if follower <= 0 or followee <= 0 or follower == followee:
                continue
            follows_by_follower.setdefault(follower, set()).add(followee)

    if interactions.empty:
        empty = pd.DataFrame(columns=["user_id", "tmdb_id", "score"])
        return RecoArtifacts(
            interactions=empty,
            user_item=pd.DataFrame(),
            sparse_matrix=csr_matrix((0, 0)),
            user_ids=np.array([], dtype=np.int64),
            item_ids=np.array([], dtype=np.int64),
            user_index={},
            item_index={},
            knn=None,
            item_knn=None,
            svd=None,
            item_factors=None,
            popularity=pd.Series(dtype=float),
            follows_by_follower=follows_by_follower,
        )

    normalized = _normalize_scores(interactions)
    if normalized.empty:
        return train_artifacts(pd.DataFrame(), follows=follows)

    user_item = normalized.pivot_table(
        index="user_id",
        columns="tmdb_id",
        values="score",
        fill_value=0.0,
        aggfunc="sum",
    )
    user_ids = user_item.index.to_numpy(dtype=np.int64)
    item_ids = user_item.columns.to_numpy(dtype=np.int64)
    sparse = csr_matrix(user_item.values)

    user_index = {int(uid): idx for idx, uid in enumerate(user_ids)}
    item_index = {int(iid): idx for idx, iid in enumerate(item_ids)}

    knn: NearestNeighbors | None = None
    if sparse.shape[0] >= 2 and sparse.shape[1] >= 1:
        knn = NearestNeighbors(metric="cosine", algorithm="brute")
        knn.fit(sparse)

    item_knn: NearestNeighbors | None = None
    if sparse.shape[1] >= 2 and sparse.shape[0] >= 1:
        item_knn = NearestNeighbors(metric="cosine", algorithm="brute")
        item_knn.fit(sparse.T)

    svd: TruncatedSVD | None = None
    item_factors: np.ndarray | None = None
    if sparse.shape[0] >= 2 and sparse.shape[1] >= 2:
        n_components = max(2, min(32, sparse.shape[0] - 1, sparse.shape[1] - 1))
        if n_components >= 2:
            svd = TruncatedSVD(n_components=n_components, random_state=42)
            item_factors = svd.fit_transform(sparse.T)

    popularity = (
        normalized.groupby("tmdb_id")["score"].sum().sort_values(ascending=False)
    )

    return RecoArtifacts(
        interactions=normalized,
        user_item=user_item,
        sparse_matrix=sparse,
        user_ids=user_ids,
        item_ids=item_ids,
        user_index=user_index,
        item_index=item_index,
        knn=knn,
        item_knn=item_knn,
        svd=svd,
        item_factors=item_factors,
        popularity=popularity,
        follows_by_follower=follows_by_follower,
    )


def _knn_scores(art: RecoArtifacts, user_id: int, k_neighbors: int = 20) -> Dict[int, float]:
    if art.knn is None or user_id not in art.user_index:
        return {}

    uidx = art.user_index[user_id]
    row = art.sparse_matrix[uidx]
    k = max(2, min(k_neighbors, art.sparse_matrix.shape[0]))
    distances, indices = art.knn.kneighbors(row, n_neighbors=k)

    scores: Dict[int, float] = {}
    supports: Dict[int, float] = {}
    sims = 1.0 - distances[0]
    for neighbor_pos, neighbor_uidx in enumerate(indices[0]):
        if int(neighbor_uidx) == int(uidx):
            continue
        sim = float(sims[neighbor_pos])
        if sim <= 0.01:
            continue
        neighbor_vec = art.sparse_matrix[int(neighbor_uidx)].toarray().ravel()
        if neighbor_vec.size == 0:
            continue
        neighbor_norm = float(np.linalg.norm(neighbor_vec))
        if neighbor_norm <= 0:
            continue
        neighbor_density = max(0.8, float(np.log1p(np.count_nonzero(neighbor_vec))))
        for item_idx, value in enumerate(neighbor_vec):
            if value <= 0:
                continue
            item_id = int(art.item_ids[item_idx])
            contribution = sim * (float(value) / neighbor_norm) * neighbor_density
            scores[item_id] = scores.get(item_id, 0.0) + contribution
            supports[item_id] = supports.get(item_id, 0.0) + sim

    out: Dict[int, float] = {}
    for item_id, raw in scores.items():
        support = float(supports.get(item_id, 0.0))
        if support <= 0:
            continue
        confidence = min(1.25, 0.55 + float(np.log1p(support)))
        out[item_id] = float((raw / support) * confidence)
    return out


def _svd_scores(art: RecoArtifacts, user_id: int) -> Dict[int, float]:
    if art.item_factors is None or user_id not in art.user_index:
        return {}
    uidx = art.user_index[user_id]
    user_vec = art.sparse_matrix[uidx].toarray().ravel()
    if not np.any(user_vec > 0):
        return {}

    weighted = art.item_factors * user_vec.reshape(-1, 1)
    profile = weighted.sum(axis=0) / max(float(user_vec.sum()), 1e-8)
    raw = art.item_factors @ profile

    out: Dict[int, float] = {}
    for item_idx, score in enumerate(raw):
        out[int(art.item_ids[item_idx])] = float(score)
    return out


def _item_knn_scores(art: RecoArtifacts, user_id: int, k_neighbors: int = 30) -> Dict[int, float]:
    if art.item_knn is None or user_id not in art.user_index:
        return {}

    uidx = art.user_index[user_id]
    user_vec = art.sparse_matrix[uidx].toarray().ravel()
    seen_item_indices = [i for i, val in enumerate(user_vec) if float(val) > 0]
    if not seen_item_indices:
        return {}

    scores: Dict[int, float] = {}
    supports: Dict[int, float] = {}
    n_items = art.sparse_matrix.shape[1]
    k = max(2, min(k_neighbors, n_items))
    seed_total_strength = float(sum(float(user_vec[idx]) for idx in seen_item_indices)) or 1.0

    for item_idx in seen_item_indices:
        base_strength = float(user_vec[item_idx])
        if base_strength <= 0:
            continue
        normalized_base = base_strength / seed_total_strength
        distances, indices = art.item_knn.kneighbors(
            art.sparse_matrix.T[item_idx], n_neighbors=k
        )
        sims = 1.0 - distances[0]
        for pos, neighbor_item_idx in enumerate(indices[0]):
            if int(neighbor_item_idx) == int(item_idx):
                continue
            sim = float(sims[pos])
            if sim <= 0.01:
                continue
            neighbor_item_id = int(art.item_ids[int(neighbor_item_idx)])
            contribution = sim * normalized_base
            scores[neighbor_item_id] = scores.get(neighbor_item_id, 0.0) + contribution
            supports[neighbor_item_id] = supports.get(neighbor_item_id, 0.0) + contribution

    out: Dict[int, float] = {}
    for item_id, raw in scores.items():
        support = float(supports.get(item_id, 0.0))
        confidence = min(1.2, 0.6 + float(np.log1p(max(0.0, support))))
        out[item_id] = float(raw * confidence)
    return out


def _profile_seed_indices(
    art: RecoArtifacts, user_id: int, seed_count: int = PROFILE_SEED_COUNT
) -> List[int]:
    if user_id not in art.user_index:
        return []

    uidx = art.user_index[user_id]
    user_vec = art.sparse_matrix[uidx].toarray().ravel()
    ranked = [
        (idx, float(value))
        for idx, value in enumerate(user_vec)
        if float(value) > 0
    ]
    if not ranked:
        return []

    ranked.sort(key=lambda row: row[1], reverse=True)
    return [int(idx) for idx, _ in ranked[: max(1, seed_count)]]


def _profile_similar_scores(
    art: RecoArtifacts,
    user_id: int,
    seed_count: int = PROFILE_SEED_COUNT,
    k_neighbors: int = PROFILE_NEIGHBOR_COUNT,
) -> Dict[int, float]:
    if art.item_knn is None or user_id not in art.user_index:
        return {}

    uidx = art.user_index[user_id]
    user_vec = art.sparse_matrix[uidx].toarray().ravel()
    seed_indices = _profile_seed_indices(art, user_id, seed_count=seed_count)
    if not seed_indices:
        return {}

    scores: Dict[int, float] = {}
    n_items = art.sparse_matrix.shape[1]
    k = max(2, min(k_neighbors, n_items))
    seed_total = max(1, len(seed_indices))
    seed_total_strength = float(sum(float(user_vec[idx]) for idx in seed_indices)) or 1.0

    for rank, item_idx in enumerate(seed_indices):
        base_strength = float(user_vec[item_idx])
        if base_strength <= 0:
            continue
        normalized_base = base_strength / seed_total_strength
        # Stronger boost for top profile seeds (favorites/high ratings first).
        rank_boost = 1.0 + ((seed_total - rank) / seed_total) * 0.6
        distances, indices = art.item_knn.kneighbors(
            art.sparse_matrix.T[item_idx], n_neighbors=k
        )
        sims = 1.0 - distances[0]
        for pos, neighbor_item_idx in enumerate(indices[0]):
            if int(neighbor_item_idx) == int(item_idx):
                continue
            sim = float(sims[pos])
            if sim <= 0:
                continue
            neighbor_item_id = int(art.item_ids[int(neighbor_item_idx)])
            scores[neighbor_item_id] = (
                scores.get(neighbor_item_id, 0.0) + sim * normalized_base * rank_boost
            )

    return scores


def _merge_item_signals(
    item_knn_scores: Dict[int, float],
    profile_similar_scores: Dict[int, float],
    profile_weight: float = PROFILE_ITEM_BLEND_WEIGHT,
) -> Dict[int, float]:
    if not item_knn_scores and not profile_similar_scores:
        return {}

    out: Dict[int, float] = {}
    base_weight = max(0.0, 1.0 - profile_weight)
    keys = set(item_knn_scores) | set(profile_similar_scores)
    for item_id in keys:
        i_score = float(item_knn_scores.get(item_id, 0.0))
        p_score = float(profile_similar_scores.get(item_id, 0.0))
        if i_score <= 0:
            out[item_id] = p_score
        elif p_score <= 0:
            out[item_id] = i_score
        else:
            out[item_id] = base_weight * i_score + profile_weight * p_score
    return out


def _seen_items(art: RecoArtifacts, user_id: int) -> set[int]:
    if user_id not in art.user_index:
        return set()
    uidx = art.user_index[user_id]
    user_vec = art.sparse_matrix[uidx].toarray().ravel()
    return {int(art.item_ids[i]) for i, val in enumerate(user_vec) if float(val) > 0}


def _follow_scores(art: RecoArtifacts, user_id: int) -> Dict[int, float]:
    followees = art.follows_by_follower.get(user_id, set())
    if not followees:
        return {}

    scores: Dict[int, float] = {}
    user_vec = None
    user_norm = 0.0
    if user_id in art.user_index:
        user_vec = art.sparse_matrix[art.user_index[user_id]].toarray().ravel()
        user_norm = float(np.linalg.norm(user_vec))

    for followee_id in followees:
        if followee_id not in art.user_index:
            continue
        followee_vec = art.sparse_matrix[art.user_index[followee_id]].toarray().ravel()
        if not np.any(followee_vec > 0):
            continue

        similarity = 0.0
        if user_vec is not None and user_norm > 0:
            followee_norm = float(np.linalg.norm(followee_vec))
            if followee_norm > 0:
                similarity = float(np.dot(user_vec, followee_vec) / (user_norm * followee_norm))
                similarity = float(max(0.0, min(1.0, similarity)))

        weight = 0.9 + 1.3 * similarity
        for item_idx, value in enumerate(followee_vec):
            if value <= 0:
                continue
            item_id = int(art.item_ids[item_idx])
            scores[item_id] = scores.get(item_id, 0.0) + weight * float(value)

    return scores


def _effective_blend_weights(art: RecoArtifacts, user_id: int, seen_count: int) -> Dict[str, float]:
    if seen_count >= 18:
        base = {"user_knn": 0.37, "item_knn": 0.33, "svd": 0.20, "follow_taste": 0.08, "popularity": 0.02}
    elif seen_count >= 8:
        base = {"user_knn": 0.35, "item_knn": 0.31, "svd": 0.20, "follow_taste": 0.10, "popularity": 0.04}
    elif seen_count >= 1:
        base = {"user_knn": 0.28, "item_knn": 0.24, "svd": 0.18, "follow_taste": 0.10, "popularity": 0.20}
    else:
        base = {"user_knn": 0.08, "item_knn": 0.06, "svd": 0.06, "follow_taste": 0.05, "popularity": 0.75}

    follow_count = len(art.follows_by_follower.get(user_id, set()))
    if follow_count <= 0:
        moved = base["follow_taste"]
        base["follow_taste"] = 0.0
        base["item_knn"] += moved * 0.50
        base["svd"] += moved * 0.30
        base["popularity"] += moved * 0.20
    elif follow_count >= 5:
        base["follow_taste"] = min(0.22, base["follow_taste"] + 0.03)
        base["popularity"] = max(0.01, base["popularity"] - 0.02)

    total = float(sum(base.values())) or 1.0
    return {k: float(v / total) for k, v in base.items()}


def _normalize_component_scores(scores: Dict[int, float], use_log: bool = False) -> Dict[int, float]:
    if not scores:
        return {}

    keys = list(scores.keys())
    values = np.array([float(scores[k]) for k in keys], dtype=np.float64)
    values = np.maximum(values, 0.0)
    if use_log:
        values = np.log1p(values)

    max_v = float(values.max())
    min_v = float(values.min())
    if max_v <= min_v + 1e-12:
        return {int(k): (1.0 if max_v > 0 else 0.0) for k in keys}

    out: Dict[int, float] = {}
    scale = max_v - min_v
    for idx, key in enumerate(keys):
        out[int(key)] = float((values[idx] - min_v) / scale)
    return out


def recommend(
    art: RecoArtifacts,
    user_id: int,
    top_n: int = 20,
) -> List[Tuple[int, float, str]]:
    if art.user_item.empty:
        return []

    seen = _seen_items(art, user_id)

    knn_scores_raw = _knn_scores(art, user_id)
    item_scores_raw = _item_knn_scores(art, user_id)
    profile_scores_raw = _profile_similar_scores(art, user_id)
    svd_scores_raw = _svd_scores(art, user_id)
    follow_scores_raw = _follow_scores(art, user_id)
    popularity_raw = {int(k): float(v) for k, v in art.popularity.items()}

    knn_scores = _normalize_component_scores(knn_scores_raw)
    item_scores = _normalize_component_scores(item_scores_raw)
    profile_scores = _normalize_component_scores(profile_scores_raw)
    item_profile_scores = _merge_item_signals(item_scores, profile_scores)
    svd_scores = _normalize_component_scores(svd_scores_raw)
    follow_scores = _normalize_component_scores(follow_scores_raw)
    popularity_scores = _normalize_component_scores(popularity_raw, use_log=True)

    blended: Dict[int, float] = {}
    seen_count = len(seen)
    user_has_history = seen_count > 0
    blend_weights = _effective_blend_weights(art, user_id, seen_count)
    if seen_count >= 12:
        min_personal_signal = MIN_PERSONAL_SIGNAL
    elif seen_count >= 6:
        min_personal_signal = MIN_PERSONAL_SIGNAL * 0.6
    else:
        min_personal_signal = 0.0

    candidates = (
        set(knn_scores)
        | set(item_profile_scores)
        | set(svd_scores)
        | set(follow_scores)
        | set(popularity_scores)
    )
    for item_id in candidates:
        if item_id in seen:
            continue
        k_score = knn_scores.get(item_id, 0.0)
        i_score = item_profile_scores.get(item_id, 0.0)
        s_score = svd_scores.get(item_id, 0.0)
        f_score = follow_scores.get(item_id, 0.0)
        p_score = popularity_scores.get(item_id, 0.0)
        personal_strength = max(k_score, i_score, s_score, f_score)

        if (
            user_has_history
            and personal_strength < min_personal_signal
            and p_score < 0.82
        ):
            continue

        score = (
            blend_weights["user_knn"] * k_score
            + blend_weights["item_knn"] * i_score
            + blend_weights["svd"] * s_score
            + blend_weights["follow_taste"] * f_score
            + blend_weights["popularity"] * p_score
        )
        if score <= 0:
            continue
        blended[item_id] = float(score)

    ranked = sorted(blended.items(), key=lambda kv: kv[1], reverse=True)[:top_n]
    out: List[Tuple[int, float, str]] = []
    for item_id, score in ranked:
        hit_knn = knn_scores.get(item_id, 0.0) > 0
        hit_item = item_scores.get(item_id, 0.0) > 0
        hit_profile = profile_scores.get(item_id, 0.0) > 0
        hit_svd = svd_scores.get(item_id, 0.0) > 0
        hit_follow = follow_scores.get(item_id, 0.0) > 0
        reason = "hybrid"
        if hit_profile and (hit_follow or hit_knn or hit_item or hit_svd):
            reason = "profile+hybrid"
        elif hit_profile:
            reason = "profile_similar"
        elif hit_follow and hit_knn and hit_item and hit_svd:
            reason = "follow+knn+item+svd"
        elif hit_follow and hit_knn and hit_item:
            reason = "follow+knn+item"
        elif hit_follow and hit_knn and hit_svd:
            reason = "follow+knn+svd"
        elif hit_follow and hit_item and hit_svd:
            reason = "follow+item+svd"
        elif hit_knn and hit_item and hit_svd:
            reason = "knn+item+svd"
        elif hit_knn and hit_item:
            reason = "knn+item"
        elif hit_knn and hit_svd:
            reason = "knn+svd"
        elif hit_item and hit_svd:
            reason = "item+svd"
        elif hit_knn:
            reason = "knn"
        elif hit_item:
            reason = "item_knn"
        elif hit_svd:
            reason = "svd"
        elif hit_follow:
            reason = "follow_taste"
        else:
            reason = "popularity"
        out.append((int(item_id), float(score), reason))
    return out


def explain_recommendation(art: RecoArtifacts, user_id: int, tmdb_id: int) -> Dict[str, object]:
    seen = _seen_items(art, user_id)
    blend_weights = _effective_blend_weights(art, user_id, len(seen))
    knn_scores = _normalize_component_scores(_knn_scores(art, user_id))
    item_scores = _normalize_component_scores(_item_knn_scores(art, user_id))
    profile_scores = _normalize_component_scores(_profile_similar_scores(art, user_id))
    item_profile_scores = _merge_item_signals(item_scores, profile_scores)
    svd_scores = _normalize_component_scores(_svd_scores(art, user_id))
    follow_scores = _normalize_component_scores(_follow_scores(art, user_id))
    popularity_scores = _normalize_component_scores(
        {int(k): float(v) for k, v in art.popularity.items()}, use_log=True
    )
    p_score = float(popularity_scores.get(tmdb_id, 0.0))

    score_parts = {
        "user_knn": blend_weights["user_knn"] * float(knn_scores.get(tmdb_id, 0.0)),
        "item_knn": blend_weights["item_knn"] * float(item_profile_scores.get(tmdb_id, 0.0)),
        "svd": blend_weights["svd"] * float(svd_scores.get(tmdb_id, 0.0)),
        "follow_taste": blend_weights["follow_taste"] * float(follow_scores.get(tmdb_id, 0.0)),
        "popularity": blend_weights["popularity"] * p_score,
    }
    final_score = float(sum(score_parts.values()))

    if user_id in art.user_index and art.knn is not None:
        uidx = art.user_index[user_id]
        k = max(2, min(15, art.sparse_matrix.shape[0]))
        distances, indices = art.knn.kneighbors(art.sparse_matrix[uidx], n_neighbors=k)
        neighbor_users: List[Dict[str, float]] = []
        target_idx = art.item_index.get(tmdb_id)
        for pos, nuidx in enumerate(indices[0]):
            if int(nuidx) == int(uidx):
                continue
            sim = float(1.0 - distances[0][pos])
            if sim <= 0:
                continue
            liked = 0.0
            if target_idx is not None:
                liked = float(art.sparse_matrix[int(nuidx), int(target_idx)])
            if liked <= 0:
                continue
            neighbor_users.append(
                {"user_id": int(art.user_ids[int(nuidx)]), "similarity": sim, "interaction_score": liked}
            )
        neighbor_users = sorted(
            neighbor_users, key=lambda x: (x["similarity"] * x["interaction_score"]), reverse=True
        )[:5]
    else:
        neighbor_users = []

    anchors: List[Dict[str, float]] = []
    if user_id in art.user_index and art.item_knn is not None and tmdb_id in art.item_index:
        uidx = art.user_index[user_id]
        user_vec = art.sparse_matrix[uidx].toarray().ravel()
        seed_indices = _profile_seed_indices(art, user_id, seed_count=PROFILE_SEED_COUNT)
        seen_indices = (
            seed_indices
            if seed_indices
            else [i for i, val in enumerate(user_vec) if float(val) > 0]
        )
        target_idx = art.item_index[tmdb_id]
        for idx in seen_indices:
            if idx == target_idx:
                continue
            # fallback: approximate similarity via cosine over item vectors
            a = art.sparse_matrix.T[idx].toarray().ravel()
            b = art.sparse_matrix.T[target_idx].toarray().ravel()
            denom = float(np.linalg.norm(a) * np.linalg.norm(b))
            sim = float(np.dot(a, b) / denom) if denom > 0 else 0.0
            if sim <= 0:
                continue
            anchors.append(
                {"tmdb_id": int(art.item_ids[idx]), "similarity": sim, "user_strength": float(user_vec[idx])}
            )
        anchors = sorted(
            anchors, key=lambda x: (x["similarity"] * x["user_strength"]), reverse=True
        )[:5]

    return {
        "user_id": int(user_id),
        "tmdb_id": int(tmdb_id),
        "already_seen": bool(tmdb_id in seen),
        "final_score": final_score,
        "score_parts": score_parts,
        "top_neighbor_users": neighbor_users,
        "similar_seen_items": anchors,
    }
