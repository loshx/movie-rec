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


def _normalize_scores(df: pd.DataFrame) -> pd.DataFrame:
    work = df.copy()
    work["event_weight"] = work["event_type"].map(EVENT_WEIGHTS).fillna(0.0)

    rating_mask = work["event_type"] == "rating"
    work.loc[rating_mask, "event_weight"] = (
        work.loc[rating_mask, "event_value"].fillna(0.0) / 5.0
    )

    work = work[work["event_weight"] > 0]
    grouped = (
        work.groupby(["user_id", "tmdb_id"], as_index=False)["event_weight"]
        .sum()
        .rename(columns={"event_weight": "score"})
    )
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
        return train_artifacts(pd.DataFrame())

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
    sims = 1.0 - distances[0]
    for neighbor_pos, neighbor_uidx in enumerate(indices[0]):
        if int(neighbor_uidx) == int(uidx):
            continue
        sim = float(sims[neighbor_pos])
        if sim <= 0:
            continue
        neighbor_vec = art.sparse_matrix[int(neighbor_uidx)].toarray().ravel()
        for item_idx, value in enumerate(neighbor_vec):
            if value <= 0:
                continue
            item_id = int(art.item_ids[item_idx])
            scores[item_id] = scores.get(item_id, 0.0) + sim * float(value)
    return scores


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
    n_items = art.sparse_matrix.shape[1]
    k = max(2, min(k_neighbors, n_items))

    for item_idx in seen_item_indices:
        base_strength = float(user_vec[item_idx])
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
            scores[neighbor_item_id] = scores.get(neighbor_item_id, 0.0) + sim * base_strength

    return scores


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


def recommend(
    art: RecoArtifacts,
    user_id: int,
    top_n: int = 20,
) -> List[Tuple[int, float, str]]:
    if art.user_item.empty:
        return []

    seen = _seen_items(art, user_id)

    knn_scores = _knn_scores(art, user_id)
    item_scores = _item_knn_scores(art, user_id)
    svd_scores = _svd_scores(art, user_id)
    follow_scores = _follow_scores(art, user_id)

    blended: Dict[int, float] = {}
    candidates = (
        set(knn_scores)
        | set(item_scores)
        | set(svd_scores)
        | set(follow_scores)
        | set(art.popularity.index.to_list())
    )
    for item_id in candidates:
        if item_id in seen:
            continue
        k_score = knn_scores.get(item_id, 0.0)
        i_score = item_scores.get(item_id, 0.0)
        s_score = svd_scores.get(item_id, 0.0)
        f_score = follow_scores.get(item_id, 0.0)
        p_score = float(art.popularity.get(item_id, 0.0))
        blended[item_id] = 0.32 * k_score + 0.20 * i_score + 0.20 * s_score + 0.10 * p_score + 0.18 * f_score

    ranked = sorted(blended.items(), key=lambda kv: kv[1], reverse=True)[:top_n]
    out: List[Tuple[int, float, str]] = []
    for item_id, score in ranked:
        hit_knn = item_id in knn_scores
        hit_item = item_id in item_scores
        hit_svd = item_id in svd_scores
        hit_follow = item_id in follow_scores
        reason = "hybrid"
        if hit_follow and hit_knn and hit_item and hit_svd:
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
    knn_scores = _knn_scores(art, user_id)
    item_scores = _item_knn_scores(art, user_id)
    svd_scores = _svd_scores(art, user_id)
    follow_scores = _follow_scores(art, user_id)
    p_score = float(art.popularity.get(tmdb_id, 0.0))

    score_parts = {
        "user_knn": 0.32 * float(knn_scores.get(tmdb_id, 0.0)),
        "item_knn": 0.20 * float(item_scores.get(tmdb_id, 0.0)),
        "svd": 0.20 * float(svd_scores.get(tmdb_id, 0.0)),
        "follow_taste": 0.18 * float(follow_scores.get(tmdb_id, 0.0)),
        "popularity": 0.10 * p_score,
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
        seen_indices = [i for i, val in enumerate(user_vec) if float(val) > 0]
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
